import { PROTOCOL_VERSION, contentDigest, validateSchema } from "@universal-harness-internal/core";

import { PolicyError, type PolicyAction } from "./action.js";
import { policyNumber, policyStrings, type EffectivePolicy } from "./decision.js";
import { isPathWithinScopes, normalizeRepoRelativePath } from "./path-boundary.js";

/**
 * Capability Grant (design 13.2 Task Envelope; plan task 15 step 3). A grant
 * is issued by the Harness for exactly one task and is always a narrowing of
 * the effective policy -- never of the adapter's requests. Grants carry the
 * effective policy digest they were derived from; dynamic narrowing during a
 * run only ever removes capabilities, paths, tools or budget, so a loop can
 * shrink a grant but no actor can grow it back.
 */
export interface GrantedTool {
  readonly name: string;
  /** Optional per-parameter allow-lists the invocation must stay within. */
  readonly parameter_bounds?: Readonly<Record<string, readonly (string | number | boolean)[]>>;
}

export interface GrantBudget {
  readonly steps: number;
  readonly tokens: number;
}

export interface CapabilityGrant {
  readonly grant_id: string;
  readonly task_id: string;
  /** Grants are minted by the Harness control plane only. */
  readonly issued_by: "harness";
  readonly capabilities: readonly string[];
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
  readonly state_fields: readonly string[];
  readonly tools: readonly GrantedTool[];
  readonly phase: string;
  readonly budget: GrantBudget;
  readonly approval_digests: readonly string[];
  readonly effective_policy_digest: string;
  readonly digest: string;
}

export interface GrantRequest {
  readonly grant_id: string;
  readonly task_id: string;
  readonly capabilities: readonly string[];
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
  readonly state_fields?: readonly string[];
  readonly tools?: readonly GrantedTool[];
  readonly phase: string;
  readonly budget: GrantBudget;
  readonly approval_digests?: readonly string[];
}

export interface GrantNarrowing {
  readonly capabilities?: readonly string[];
  readonly read_paths?: readonly string[];
  readonly write_paths?: readonly string[];
  readonly state_fields?: readonly string[];
  readonly tools?: readonly GrantedTool[];
  readonly budget?: GrantBudget;
}

export interface CapabilityGrantSpec extends Omit<CapabilityGrant, "digest"> {
  readonly plan_digest: string;
  readonly context_bundle_digest: string;
  readonly adapter_profile_digest?: string;
  readonly baseline_commit: string;
  readonly spec_digest: string;
}

export interface CapabilityGrantBinding {
  readonly planDigest: string;
  readonly contextBundleDigest: string;
  readonly adapterProfileDigest?: string;
  readonly baselineCommit: string;
}

export interface CapabilityGrantRecord {
  readonly protocol_version: string;
  readonly record_kind: "capability_grant";
  readonly grant_record_id: string;
  readonly iteration_id: string;
  readonly spec: CapabilityGrantSpec;
  readonly authorization_digest: string;
  readonly issued_at: string;
  readonly digest: string;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function assertSubset(
  requested: readonly string[],
  allowed: readonly string[],
  what: string,
): void {
  for (const value of requested) {
    if (!allowed.includes(value)) {
      throw new PolicyError(
        "capability_expansion",
        `grant requests ${what} "${value}" beyond the effective policy`,
      );
    }
  }
}

function grantDigest(parts: Omit<CapabilityGrant, "digest">): string {
  return contentDigest({
    grant_id: parts.grant_id,
    task_id: parts.task_id,
    issued_by: parts.issued_by,
    capabilities: parts.capabilities,
    read_paths: parts.read_paths,
    write_paths: parts.write_paths,
    state_fields: parts.state_fields,
    tools: parts.tools,
    phase: parts.phase,
    budget: parts.budget,
    approval_digests: parts.approval_digests,
    effective_policy_digest: parts.effective_policy_digest,
  });
}

/**
 * Issue a grant for one task as a narrowing of the effective policy.
 * Requested capabilities, paths and tools beyond the policy throw a typed
 * capability_expansion; budgets above a hard ceiling are clamped down
 * (lowering a ceiling never needs approval). All path sets are normalized to
 * canonical repository-relative form.
 */
export function issueGrant(request: GrantRequest, effective: EffectivePolicy): CapabilityGrant {
  const denyCapabilities = policyStrings(effective, "capabilities.deny") ?? [];
  const allowCapabilities = policyStrings(effective, "capabilities.allow");
  const capabilities = sortedUnique(request.capabilities);
  if (allowCapabilities !== undefined) {
    assertSubset(capabilities, allowCapabilities, "capability");
  }
  for (const capability of capabilities) {
    if (denyCapabilities.includes(capability)) {
      throw new PolicyError(
        "capability_expansion",
        `grant requests explicitly denied capability "${capability}"`,
      );
    }
  }

  const denyPaths = policyStrings(effective, "paths.deny") ?? [];
  const allowRead = policyStrings(effective, "paths.read.allow");
  const allowWrite = policyStrings(effective, "paths.write.allow");
  const readPaths = sortedUnique(request.read_paths.map(normalizeRepoRelativePath));
  const writePaths = sortedUnique(request.write_paths.map(normalizeRepoRelativePath));
  for (const path of readPaths) {
    if (allowRead !== undefined && !isPathWithinScopes(allowRead, path)) {
      throw new PolicyError(
        "capability_expansion",
        `grant requests read path "${path}" outside the effective policy allow set`,
      );
    }
  }
  for (const path of writePaths) {
    if (allowWrite !== undefined && !isPathWithinScopes(allowWrite, path)) {
      throw new PolicyError(
        "capability_expansion",
        `grant requests write path "${path}" outside the effective policy allow set`,
      );
    }
    if (isPathWithinScopes(denyPaths, path)) {
      throw new PolicyError(
        "capability_expansion",
        `grant requests explicitly denied write path "${path}"`,
      );
    }
  }

  const allowResources = policyStrings(effective, "resources.allow");
  const tools = [...(request.tools ?? [])].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  if (allowResources !== undefined) {
    assertSubset(
      tools.map((tool) => tool.name),
      allowResources,
      "tool",
    );
  }

  const allowPhases = policyStrings(effective, "phases.allow");
  if (allowPhases !== undefined && !allowPhases.includes(request.phase)) {
    throw new PolicyError(
      "capability_expansion",
      `grant requests phase "${request.phase}" outside the effective policy allow set`,
    );
  }

  const maxSteps = policyNumber(effective, "budgets.max_steps");
  const maxTokens = policyNumber(effective, "budgets.max_tokens");
  const budget: GrantBudget = {
    steps: maxSteps === undefined ? request.budget.steps : Math.min(request.budget.steps, maxSteps),
    tokens:
      maxTokens === undefined ? request.budget.tokens : Math.min(request.budget.tokens, maxTokens),
  };

  const grant: Omit<CapabilityGrant, "digest"> = {
    grant_id: request.grant_id,
    task_id: request.task_id,
    issued_by: "harness",
    capabilities,
    read_paths: readPaths,
    write_paths: writePaths,
    state_fields: sortedUnique(request.state_fields ?? []),
    tools,
    phase: request.phase,
    budget,
    approval_digests: sortedUnique(request.approval_digests ?? []),
    effective_policy_digest: effective.digest,
  };
  return { ...grant, digest: grantDigest(grant) };
}

/** Build the authorization-free portion first so no grant/authorization digest cycle can form. */
export function createCapabilityGrantSpec(
  request: GrantRequest,
  effective: EffectivePolicy,
  binding: CapabilityGrantBinding,
): CapabilityGrantSpec {
  const grant = issueGrant(request, effective);
  const base = {
    grant_id: grant.grant_id,
    task_id: grant.task_id,
    issued_by: grant.issued_by,
    capabilities: grant.capabilities,
    read_paths: grant.read_paths,
    write_paths: grant.write_paths,
    state_fields: grant.state_fields,
    tools: grant.tools,
    phase: grant.phase,
    budget: grant.budget,
    approval_digests: grant.approval_digests,
    effective_policy_digest: grant.effective_policy_digest,
    plan_digest: binding.planDigest,
    context_bundle_digest: binding.contextBundleDigest,
    ...(binding.adapterProfileDigest === undefined
      ? {}
      : { adapter_profile_digest: binding.adapterProfileDigest }),
    baseline_commit: binding.baselineCommit,
  };
  return { ...base, spec_digest: contentDigest(base) };
}

export function bindCapabilityGrantAuthorization(
  spec: CapabilityGrantSpec,
  binding: {
    readonly grantRecordId: string;
    readonly iterationId: string;
    readonly authorizationDigest: string;
    readonly issuedAt: string;
  },
): CapabilityGrantRecord {
  const base = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "capability_grant" as const,
    grant_record_id: binding.grantRecordId,
    iteration_id: binding.iterationId,
    spec,
    authorization_digest: binding.authorizationDigest,
    issued_at: binding.issuedAt,
  };
  const record = { ...base, digest: contentDigest(base) };
  const validation = validateSchema("runtime", record);
  if (!validation.valid) {
    throw new PolicyError(
      "invalid_action",
      `invalid capability grant record: ${validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  return record;
}

function assertSetNarrowing(
  current: readonly string[],
  narrowed: readonly string[],
  what: string,
): readonly string[] {
  const next = sortedUnique(narrowed);
  for (const value of next) {
    if (!current.includes(value)) {
      throw new PolicyError(
        "capability_expansion",
        `narrowing may never widen a grant: "${value}" is not in the current ${what}`,
      );
    }
  }
  return next;
}

function assertToolNarrowing(
  current: readonly GrantedTool[],
  narrowed: readonly GrantedTool[],
): readonly GrantedTool[] {
  const next = [...narrowed].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const tool of next) {
    const previous = current.find((candidate) => candidate.name === tool.name);
    if (previous === undefined) {
      throw new PolicyError(
        "capability_expansion",
        `narrowing may never widen a grant: tool "${tool.name}" was not granted`,
      );
    }
    for (const [key, values] of Object.entries(tool.parameter_bounds ?? {})) {
      const previousValues = previous.parameter_bounds?.[key];
      if (previousValues === undefined) continue;
      for (const value of values) {
        if (!previousValues.includes(value)) {
          throw new PolicyError(
            "capability_expansion",
            `narrowing may never widen a grant: parameter bound ${tool.name}.${key} ` +
              `does not cover ${JSON.stringify(value)}`,
          );
        }
      }
    }
  }
  return next;
}

/**
 * Dynamically narrow an active grant (design 13.3: every step may shrink the
 * grant, none may grow it). Any widening attempt -- a new capability, path,
 * state field, tool, looser parameter bound or larger budget -- throws a typed
 * capability_expansion. The returned grant is a new immutable record with a
 * fresh digest; the input grant is unchanged.
 */
export function narrowGrant(grant: CapabilityGrant, narrowing: GrantNarrowing): CapabilityGrant {
  const next: Omit<CapabilityGrant, "digest"> = {
    grant_id: grant.grant_id,
    task_id: grant.task_id,
    issued_by: grant.issued_by,
    capabilities:
      narrowing.capabilities === undefined
        ? grant.capabilities
        : assertSetNarrowing(grant.capabilities, narrowing.capabilities, "capabilities"),
    read_paths:
      narrowing.read_paths === undefined
        ? grant.read_paths
        : assertSetNarrowing(
            grant.read_paths,
            narrowing.read_paths.map(normalizeRepoRelativePath),
            "read paths",
          ),
    write_paths:
      narrowing.write_paths === undefined
        ? grant.write_paths
        : assertSetNarrowing(
            grant.write_paths,
            narrowing.write_paths.map(normalizeRepoRelativePath),
            "write paths",
          ),
    state_fields:
      narrowing.state_fields === undefined
        ? grant.state_fields
        : assertSetNarrowing(grant.state_fields, narrowing.state_fields, "state fields"),
    tools:
      narrowing.tools === undefined
        ? grant.tools
        : assertToolNarrowing(grant.tools, narrowing.tools),
    phase: grant.phase,
    budget:
      narrowing.budget === undefined
        ? grant.budget
        : {
            steps: narrowing.budget.steps,
            tokens: narrowing.budget.tokens,
          },
    approval_digests: grant.approval_digests,
    effective_policy_digest: grant.effective_policy_digest,
  };
  if (next.budget.steps > grant.budget.steps || next.budget.tokens > grant.budget.tokens) {
    throw new PolicyError(
      "capability_expansion",
      "narrowing may never widen a grant: budget ceilings can only shrink",
    );
  }
  return { ...next, digest: grantDigest(next) };
}

/**
 * Whether an action stays inside a grant. Returns undefined when it does,
 * otherwise a stable denial reason. Escalation kinds are never grant-bound --
 * the evaluator denies them for agents and adapters before this check.
 */
export function grantDenialReason(
  grant: CapabilityGrant,
  action: PolicyAction,
): string | undefined {
  if (action.phase !== grant.phase) {
    return `action phase "${action.phase}" is outside the granted phase "${grant.phase}"`;
  }
  const resource = action.resource;
  switch (action.kind) {
    case "read_path":
      if (resource === undefined || !isPathWithinScopes(grant.read_paths, resource)) {
        return `read path "${resource ?? ""}" is outside the granted read scope`;
      }
      return undefined;
    case "write_path":
      if (resource === undefined || !isPathWithinScopes(grant.write_paths, resource)) {
        return `write path "${resource ?? ""}" is outside the granted write scope`;
      }
      return undefined;
    case "propose_state":
      if (resource === undefined || !grant.state_fields.includes(resource)) {
        return `state field "${resource ?? ""}" is outside the granted state proposal scope`;
      }
      return undefined;
    case "invoke_tool": {
      if (resource === undefined) return "tool invocation requires a resource (tool name)";
      const tool = grant.tools.find((candidate) => candidate.name === resource);
      if (tool === undefined) {
        return `tool "${resource}" is not in the granted tool set`;
      }
      for (const [key, allowed] of Object.entries(tool.parameter_bounds ?? {})) {
        const value = action.parameters[key];
        if (
          (typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
          !allowed.includes(value)
        ) {
          return (
            `parameter ${resource}.${key}=${JSON.stringify(value)} is outside the granted ` +
            "parameter bounds"
          );
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
