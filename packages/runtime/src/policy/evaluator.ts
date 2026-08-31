import { contentDigest, POLICY_MERGE_OPERATORS } from "@universal-harness-internal/core";

import {
  ESCALATION_ACTION_KINDS,
  SCHEDULER_POLICY_ACTION_KINDS,
  PolicyError,
  actionDigest,
  riskRank,
  TRAJECTORY_VISIBILITIES,
  type PolicyAction,
  type PolicyRisk,
  type TrajectoryVisibility,
} from "./action.js";
import {
  buildDecision,
  policyString,
  policyStrings,
  POLICY_LAYERS,
  type EffectivePolicy,
  type EffectivePolicyField,
  type PolicyDecision,
  type PolicyLayerInput,
  type PolicyLayerRef,
  type PolicyMergeOperator,
} from "./decision.js";
import { grantDenialReason, type CapabilityGrant } from "./capability-grant.js";
import { isPathWithinScopes, tryNormalizeRepoRelativePath } from "./path-boundary.js";

/**
 * Policy evaluator (design 14.1). Installation, Pack and Project layers are
 * merged field by field through the merge operator the schema declares --
 * never by whole-object override or silent source priority:
 *
 * - hard_ceiling takes the minimum, so the Installation ceiling can never be
 *   raised by a lower layer;
 * - allow_intersection intersects Capability/Path/Resource allow sets;
 * - deny_union unions explicit denies, which always win over allows;
 * - approval_union unions approval requirements;
 * - strongest_control takes the strictest value of a schema-declared safety
 *   strength ordering;
 * - project_default lets a Project value take precedence over a Pack default.
 *
 * A field without a declared merge operator, with conflicting operators
 * across layers, or with values that cannot be ordered produces a
 * PolicyConflict and blocks; it is never silently resolved by precedence.
 */

/** Trajectory visibility ordered weakest first (the declared constant lists strongest first). */
const TRAJECTORY_STRENGTH: readonly string[] = [...TRAJECTORY_VISIBILITIES].reverse();

/** Schema-declared safety strength orderings, weakest first. */
export const CONTROL_STRENGTH_ORDERS: Readonly<Record<string, readonly string[]>> = {
  "controls.trajectory": TRAJECTORY_STRENGTH,
  "controls.redaction": ["none", "references", "full"],
  "controls.retention": ["ephemeral", "run", "release"],
  "controls.side_effect_interception": ["optional", "required"],
};

export interface MergedPolicy {
  readonly effective: EffectivePolicy;
  /** Stable conflict descriptions; a non-empty list blocks every decision. */
  readonly conflicts: readonly string[];
}

interface LayerFieldEntry {
  readonly operator: string;
  readonly value: unknown;
  readonly source: PolicyLayerRef;
}

function layerRef(layer: PolicyLayerInput): PolicyLayerRef {
  return { layer: layer.layer, revision: layer.revision, digest: layer.digest };
}

function asStringArray(path: string, operator: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new PolicyError(
      "policy_conflict",
      `policy field ${path}: ${operator} requires string-array values`,
    );
  }
  return value as readonly string[];
}

function mergeField(path: string, entries: readonly LayerFieldEntry[]): EffectivePolicyField {
  const operator = entries[0]?.operator as PolicyMergeOperator;
  const sources = entries.map((entry) => entry.source);
  const describe = (entry: LayerFieldEntry): string =>
    `${entry.source.layer}[${(entry.value as readonly string[]).join(",")}]`;
  switch (operator) {
    case "hard_ceiling": {
      for (const entry of entries) {
        if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
          throw new PolicyError(
            "policy_conflict",
            `policy field ${path}: hard_ceiling requires finite numeric values`,
          );
        }
      }
      const values = entries.map((entry) => entry.value as number);
      const merged = Math.min(...values);
      return {
        path,
        merge_operator: operator,
        value: merged,
        reason: `hard_ceiling:min(${values.join(",")})=${String(merged)}`,
        sources,
      };
    }
    case "allow_intersection": {
      let merged: readonly string[] | undefined;
      for (const entry of entries) {
        const values = asStringArray(path, operator, entry.value);
        merged = merged === undefined ? values : merged.filter((value) => values.includes(value));
      }
      const result = [...new Set(merged ?? [])].sort();
      return {
        path,
        merge_operator: operator,
        value: result,
        reason: `allow_intersection:${entries.map(describe).join(" & ")} = [${result.join(",")}]`,
        sources,
      };
    }
    case "deny_union":
    case "approval_union": {
      const result = [
        ...new Set(entries.flatMap((entry) => asStringArray(path, operator, entry.value))),
      ].sort();
      return {
        path,
        merge_operator: operator,
        value: result,
        reason: `${operator}:${entries.map(describe).join(" | ")} = [${result.join(",")}]`,
        sources,
      };
    }
    case "strongest_control": {
      const ordering = CONTROL_STRENGTH_ORDERS[path];
      if (ordering === undefined) {
        throw new PolicyError(
          "policy_conflict",
          `policy field ${path}: strongest_control has no schema-declared strength ordering`,
        );
      }
      let strongest: string | undefined;
      for (const entry of entries) {
        if (typeof entry.value !== "string" || !ordering.includes(entry.value)) {
          throw new PolicyError(
            "policy_conflict",
            `policy field ${path}: value ${JSON.stringify(entry.value)} cannot be ordered ` +
              `against the declared strength ordering [${ordering.join(",")}]`,
          );
        }
        if (
          strongest === undefined ||
          ordering.indexOf(entry.value) > ordering.indexOf(strongest)
        ) {
          strongest = entry.value;
        }
      }
      return {
        path,
        merge_operator: operator,
        value: strongest,
        reason:
          `strongest_control:strictest(${entries.map((entry) => String(entry.value)).join(",")})` +
          `=${strongest ?? ""}`,
        sources,
      };
    }
    case "project_default": {
      const precedence = [...entries].sort(
        (left, right) =>
          POLICY_LAYERS.indexOf(right.source.layer) - POLICY_LAYERS.indexOf(left.source.layer),
      );
      const winner = precedence[0] as LayerFieldEntry;
      return {
        path,
        merge_operator: operator,
        value: winner.value,
        reason: `project_default:${winner.source.layer} value wins by declared precedence`,
        sources,
      };
    }
  }
}

/**
 * Merge the policy layers field by field. Conflicting or unsortable fields
 * are collected as stable conflict descriptions instead of throwing, so the
 * caller can block with the full conflict list and the digests of every
 * layer. Throws invalid_policy only for structurally illegal input (unknown
 * layer name or a duplicate layer).
 */
export function mergePolicyLayers(layers: readonly PolicyLayerInput[]): MergedPolicy {
  const seen = new Set<string>();
  const ordered: PolicyLayerInput[] = [];
  for (const layer of layers) {
    if (!(POLICY_LAYERS as readonly string[]).includes(layer.layer)) {
      throw new PolicyError("invalid_policy", `unknown policy layer "${layer.layer}"`);
    }
    if (seen.has(layer.layer)) {
      throw new PolicyError("invalid_policy", `duplicate policy layer "${layer.layer}"`);
    }
    seen.add(layer.layer);
    ordered.push(layer);
  }
  ordered.sort(
    (left, right) => POLICY_LAYERS.indexOf(left.layer) - POLICY_LAYERS.indexOf(right.layer),
  );
  const layerRefs = ordered.map(layerRef);

  const byPath = new Map<string, LayerFieldEntry[]>();
  const conflicts: string[] = [];
  for (const layer of ordered) {
    for (const field of layer.fields) {
      if (!(POLICY_MERGE_OPERATORS as readonly string[]).includes(field.merge_operator)) {
        conflicts.push(
          `policy field ${field.path}: layer ${layer.layer} declares unknown merge operator ` +
            `"${field.merge_operator}"; without a declared merge operator the field blocks`,
        );
        continue;
      }
      const entries = byPath.get(field.path) ?? [];
      entries.push({ operator: field.merge_operator, value: field.value, source: layerRef(layer) });
      byPath.set(field.path, entries);
    }
  }

  const fields: EffectivePolicyField[] = [];
  for (const path of [...byPath.keys()].sort()) {
    const entries = byPath.get(path) as LayerFieldEntry[];
    const operators = new Set(entries.map((entry) => entry.operator));
    if (operators.size !== 1) {
      conflicts.push(
        `policy field ${path}: layers declare conflicting merge operators ` +
          `(${[...operators].sort().join(" vs ")}); the conflict blocks instead of ` +
          "being resolved by source priority",
      );
      continue;
    }
    try {
      fields.push(mergeField(path, entries));
    } catch (error) {
      if (error instanceof PolicyError && error.kind === "policy_conflict") {
        conflicts.push(error.message);
        continue;
      }
      throw error;
    }
  }
  conflicts.sort();

  const effective: EffectivePolicy = {
    fields,
    layers: layerRefs,
    digest: contentDigest({
      layers: layerRefs,
      fields: fields.map((field) => ({
        path: field.path,
        merge_operator: field.merge_operator,
        value: field.value,
      })),
    }),
  };
  return { effective, conflicts };
}

function isEscalation(action: PolicyAction): boolean {
  return (ESCALATION_ACTION_KINDS as readonly string[]).includes(action.kind);
}

function trajectoryRank(visibility: TrajectoryVisibility): number {
  return TRAJECTORY_STRENGTH.indexOf(visibility);
}

/** Risk threshold tokens in approvals.required, e.g. "risk:high". */
function riskThreshold(entry: string): PolicyRisk | undefined {
  if (!entry.startsWith("risk:")) return undefined;
  const level = entry.slice("risk:".length);
  return (["low", "medium", "high", "critical"] as const).includes(level as PolicyRisk)
    ? (level as PolicyRisk)
    : undefined;
}

/**
 * Decide one normalized action against the policy layers and, optionally, the
 * task's capability grant. The result is always an immutable, digested
 * decision record with stable reasons; a decision never produces change by
 * itself, so a denied action leaves only this trace. Evaluation order is
 * fixed: prompt-carried escalation, identity-based escalation, explicit deny,
 * grant scope, effective allow sets, adapter control capability, approval.
 * Because denies return before approval is considered, an approval can
 * satisfy requires-approval but can never turn a deny into an allow.
 */
export function decideAction(
  layers: readonly PolicyLayerInput[],
  action: PolicyAction,
  grant?: CapabilityGrant,
): PolicyDecision {
  const merged = mergePolicyLayers(layers);
  const effective = merged.effective;
  const reasons: string[] = [];
  const finish = (outcome: PolicyDecision["outcome"], approvalDigest?: string): PolicyDecision =>
    buildDecision({
      outcome,
      reasons,
      action_digest: actionDigest(action),
      effective,
      ...(approvalDigest === undefined ? {} : { approval_digest: approvalDigest }),
    });

  if (merged.conflicts.length > 0) {
    for (const conflict of merged.conflicts) reasons.push(conflict);
    reasons.push("blocked: policy conflicts are never resolved by silent source-priority override");
    return finish("block");
  }

  if (action.origin === "prompt" && isEscalation(action)) {
    reasons.push(
      `denied: untrusted context (tool output, retrieved documents, repository content or ` +
        `provider output) can never request ${action.kind}; prompts cannot modify policy, ` +
        "register tools, grant paths, approve or accept evidence",
    );
    return finish("deny");
  }

  // M4 design 5.2/11: scheduler decisions are control-plane only. An approval
  // digest carried by prompt-origin input is untrusted context and can never
  // satisfy a requires-approval rule — the claim is denied, not ignored, so
  // the attempt leaves an explicit trace.
  if (
    action.origin === "prompt" &&
    action.approval_digest !== undefined &&
    (SCHEDULER_POLICY_ACTION_KINDS as readonly string[]).includes(action.kind)
  ) {
    reasons.push(
      `denied: prompt-origin input can never carry approval authority for ${action.kind}; ` +
        "only a control-plane approval bound to the exact action satisfies requires-approval",
    );
    return finish("deny");
  }

  if (isEscalation(action) && (action.actor_kind === "agent" || action.actor_kind === "adapter")) {
    reasons.push(
      `denied: ${action.actor_kind} identity never authorizes ${action.kind}; only the ` +
        "harness control plane or a human may decide escalation actions",
    );
    return finish("deny");
  }

  const denyPaths = policyStrings(effective, "paths.deny") ?? [];
  const denyResources = policyStrings(effective, "resources.deny") ?? [];
  const denyCapabilities = policyStrings(effective, "capabilities.deny") ?? [];
  const resource = action.resource;

  if (
    (action.kind === "read_path" || action.kind === "write_path") &&
    resource !== undefined &&
    tryNormalizeRepoRelativePath(resource) === undefined
  ) {
    reasons.push(
      `denied: path "${resource}" is not a legal repository-relative path ` +
        "(traversal, absolute or reserved segments are never authorized)",
    );
    return finish("deny");
  }
  if (
    (action.kind === "read_path" || action.kind === "write_path") &&
    resource !== undefined &&
    isPathWithinScopes(denyPaths, resource)
  ) {
    reasons.push(`denied: path "${resource}" matches the explicit policy deny set`);
    return finish("deny");
  }
  if (resource !== undefined && denyResources.includes(resource)) {
    reasons.push(`denied: resource "${resource}" is in the explicit policy deny set`);
    return finish("deny");
  }
  if (
    action.kind === "invoke_tool" &&
    resource !== undefined &&
    denyCapabilities.includes(resource)
  ) {
    reasons.push(`denied: capability "${resource}" is in the explicit policy deny set`);
    return finish("deny");
  }

  if (grant !== undefined && !isEscalation(action)) {
    const grantReason = grantDenialReason(grant, action);
    if (grantReason !== undefined) {
      reasons.push(`denied: ${grantReason}`);
      return finish("deny");
    }
    if (grant.effective_policy_digest !== effective.digest) {
      reasons.push(
        "denied: the grant binds a different effective policy digest; " +
          "policy changed after the grant was issued, so the grant is stale",
      );
      return finish("deny");
    }
  }

  if (action.kind === "read_path" && resource !== undefined) {
    const allow = policyStrings(effective, "paths.read.allow");
    if (allow !== undefined && !isPathWithinScopes(allow, resource)) {
      reasons.push(`denied: read path "${resource}" is outside the effective policy allow set`);
      return finish("deny");
    }
  }
  if (action.kind === "write_path" && resource !== undefined) {
    const allow = policyStrings(effective, "paths.write.allow");
    if (allow !== undefined && !isPathWithinScopes(allow, resource)) {
      reasons.push(`denied: write path "${resource}" is outside the effective policy allow set`);
      return finish("deny");
    }
  }
  if (action.kind === "invoke_tool" && resource !== undefined) {
    const allow = policyStrings(effective, "resources.allow");
    if (allow !== undefined && !allow.includes(resource)) {
      reasons.push(`denied: resource "${resource}" is outside the effective policy allow set`);
      return finish("deny");
    }
  }
  const allowPhases = policyStrings(effective, "phases.allow");
  if (allowPhases !== undefined && !allowPhases.includes(action.phase)) {
    reasons.push(`denied: phase "${action.phase}" is outside the effective policy allow set`);
    return finish("deny");
  }

  if (action.actor_kind === "agent" || action.actor_kind === "adapter") {
    const requiredTrajectory = policyString(effective, "controls.trajectory");
    if (requiredTrajectory !== undefined) {
      const profile = action.control_profile;
      if (
        profile === undefined ||
        trajectoryRank(profile.trajectory_visibility) <
          trajectoryRank(requiredTrajectory as TrajectoryVisibility)
      ) {
        reasons.push(
          `denied: policy requires ${requiredTrajectory} trajectory evidence but the adapter ` +
            (profile === undefined
              ? "declares no control profile"
              : `only provides ${profile.trajectory_visibility}`),
        );
        return finish("deny");
      }
    }
    if (
      policyString(effective, "controls.side_effect_interception") === "required" &&
      action.control_profile?.side_effect_interception !== true
    ) {
      reasons.push(
        "denied: policy requires side-effect interception but the adapter control profile " +
          "cannot provide it",
      );
      return finish("deny");
    }
  }

  const required = policyStrings(effective, "approvals.required") ?? [];
  const requiresApproval =
    required.includes(action.kind) ||
    required.some((entry) => {
      const threshold = riskThreshold(entry);
      return threshold !== undefined && riskRank(action.risk) >= riskRank(threshold);
    });
  if (requiresApproval) {
    const approval = action.approval_digest;
    if (
      approval !== undefined &&
      (grant === undefined || grant.approval_digests.includes(approval))
    ) {
      reasons.push(
        `allowed: approval ${approval} satisfies the requires-approval rule for ` +
          `${action.kind} at ${action.risk} risk`,
      );
      return finish("allow", approval);
    }
    reasons.push(
      `requires-approval: ${action.kind} at ${action.risk} risk requires an explicit ` +
        "approval under the effective policy",
    );
    return finish("requires_approval");
  }

  reasons.push(`allowed: effective policy permits ${action.kind} at ${action.risk} risk`);
  return finish("allow");
}

/**
 * Scheduler hard-ceiling paths (M4 design 8.4). Each is a numeric ceiling the
 * Project/Pack/Installation layers merge with `hard_ceiling`; the resolver
 * below is the single place that reads them for scheduling decisions.
 */
export const SCHEDULER_MAX_CONCURRENCY_PATH = "scheduler.max_concurrency";
export const ITERATION_BUDGET_CEILING_PATHS = [
  "budgets.iteration.max_steps",
  "budgets.iteration.max_tokens",
  "budgets.iteration.max_duration_ms",
] as const;

/** Profile-level default local slot count when no ceiling is declared (M4 design 10.2). */
export const PROFILE_DEFAULT_MAX_CONCURRENCY = 2;

const LOOP_CEILING_FALLBACKS = {
  "budgets.iteration.max_steps": "loop.max_steps",
  "budgets.iteration.max_tokens": "loop.max_tokens",
  "budgets.iteration.max_duration_ms": "loop.max_duration_ms",
} as const;

export interface SchedulerIterationCeilings {
  readonly max_steps?: number;
  readonly max_tokens?: number;
  readonly max_duration_ms?: number;
}

export interface SchedulerCeilings {
  readonly max_concurrency: number;
  readonly iteration: SchedulerIterationCeilings;
}

export type SchedulerCeilingResolution =
  | {
      readonly outcome: "resolved";
      readonly ceilings: SchedulerCeilings;
      readonly reasons: readonly string[];
    }
  | { readonly outcome: "blocked"; readonly reasons: readonly string[] };

type CeilingValue =
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly value: unknown }
  | { readonly status: "ok"; readonly value: number };

function ceilingValue(effective: EffectivePolicy, path: string): CeilingValue {
  const field = effective.fields.find((candidate) => candidate.path === path);
  if (field === undefined) return { status: "missing" };
  const value = field.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { status: "invalid", value };
  }
  return { status: "ok", value };
}

/**
 * Resolve the scheduler ceilings from an effective policy (M4 design 8.4).
 * Missing fields preserve compatibility: concurrency defaults to the Profile
 * default of 2 and each iteration ceiling falls back to the already effective
 * `loop.max_*` value. A field that is present but non-numeric, non-positive —
 * or, for concurrency, non-integer — blocks instead of silently falling back:
 * a declared ceiling that cannot be honored is a policy defect, not a default.
 */
export function resolveSchedulerCeilings(effective: EffectivePolicy): SchedulerCeilingResolution {
  const reasons: string[] = [];
  const violations: string[] = [];

  let maxConcurrency = PROFILE_DEFAULT_MAX_CONCURRENCY;
  const concurrency = ceilingValue(effective, SCHEDULER_MAX_CONCURRENCY_PATH);
  if (concurrency.status === "missing") {
    reasons.push(
      `${SCHEDULER_MAX_CONCURRENCY_PATH} undeclared: defaulting to the profile default ` +
        `of ${String(PROFILE_DEFAULT_MAX_CONCURRENCY)}`,
    );
  } else if (concurrency.status === "invalid") {
    violations.push(
      `${SCHEDULER_MAX_CONCURRENCY_PATH} must be a positive integer; got ` +
        JSON.stringify(concurrency.value),
    );
  } else if (concurrency.value <= 0 || !Number.isInteger(concurrency.value)) {
    violations.push(
      `${SCHEDULER_MAX_CONCURRENCY_PATH} must be a positive integer; got ` +
        JSON.stringify(concurrency.value),
    );
  } else {
    maxConcurrency = concurrency.value;
    reasons.push(`${SCHEDULER_MAX_CONCURRENCY_PATH}=${String(concurrency.value)}`);
  }

  const iteration: {
    max_steps?: number;
    max_tokens?: number;
    max_duration_ms?: number;
  } = {};
  for (const [path, fallbackPath] of Object.entries(LOOP_CEILING_FALLBACKS)) {
    const key = path.slice("budgets.iteration.".length) as
      "max_steps" | "max_tokens" | "max_duration_ms";
    const explicit = ceilingValue(effective, path);
    if (explicit.status === "invalid" || (explicit.status === "ok" && explicit.value <= 0)) {
      violations.push(
        `${path} must be a positive finite number; got ` + JSON.stringify(explicit.value),
      );
      continue;
    }
    if (explicit.status === "ok") {
      iteration[key] = explicit.value;
      reasons.push(`${path}=${String(explicit.value)}`);
      continue;
    }
    const fallback = ceilingValue(effective, fallbackPath);
    if (fallback.status === "ok" && fallback.value > 0) {
      iteration[key] = fallback.value;
      reasons.push(`${path} undeclared: falling back to ${fallbackPath}=${String(fallback.value)}`);
    } else {
      reasons.push(`${path} undeclared and no positive ${fallbackPath} fallback: no ceiling`);
    }
  }

  if (violations.length > 0) {
    return {
      outcome: "blocked",
      reasons: [
        ...violations.sort(),
        "blocked: a declared scheduler ceiling that cannot be honored never falls back silently",
      ],
    };
  }
  return {
    outcome: "resolved",
    ceilings: { max_concurrency: maxConcurrency, iteration },
    reasons,
  };
}
