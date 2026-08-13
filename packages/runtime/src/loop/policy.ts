import { contentDigest } from "@universal-harness-internal/core";

import { PolicyError } from "../policy/action.js";
import { policyNumber, policyString, type EffectivePolicy } from "../policy/decision.js";

/**
 * LoopPolicy (design 13.3): the deterministic ceilings and termination rules a
 * managed loop runs under. Values resolve from the merged EffectivePolicy
 * (installation, pack and project layers) with the M1 Generic Pack numbers as
 * fallback defaults. Pack or approved project policy may lower any ceiling
 * without further approval; raising one requires a Policy Authorization and
 * is always clamped to the installation-level maximum. The effective policy
 * digest is embedded in the resolved policy so every run records exactly
 * which policy produced its ceilings.
 */
export const LOOP_ERROR_KINDS = [
  "invalid_loop_policy",
  "invalid_task_envelope",
  "invalid_loop_phase",
  "loop_already_terminated",
  "invalid_step_result",
] as const;

export type LoopErrorKind = (typeof LOOP_ERROR_KINDS)[number];

export class LoopError extends Error {
  readonly kind: LoopErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: LoopErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "LoopError";
    this.kind = kind;
    if (details !== undefined) this.details = details;
  }
}

export const BUDGET_CEILING_MODES = ["hard", "soft"] as const;

export type BudgetCeilingMode = (typeof BUDGET_CEILING_MODES)[number];

/**
 * Repeat detection is structural: there is no `enabled` flag anywhere in the
 * policy, so no actor -- and in particular no model -- can switch it off.
 */
export interface RepeatDetectionPolicy {
  readonly window: number;
  readonly identical_action_limit: number;
}

export interface TerminationPolicy {
  readonly require_structured_signal: boolean;
  readonly require_external_verification: boolean;
  readonly budget_ceiling: BudgetCeilingMode;
}

export interface LoopPolicy {
  readonly max_steps: number;
  readonly max_tokens: number;
  readonly max_duration_ms: number;
  readonly max_tool_retries: number;
  readonly repeat_detection: RepeatDetectionPolicy;
  readonly termination: TerminationPolicy;
  readonly effective_policy_digest: string;
  readonly digest: string;
}

/** M1 Generic Pack defaults (design 13.3); a fallback base, not a global constant. */
export const GENERIC_PACK_LOOP_DEFAULTS = {
  max_steps: 30,
  max_tokens: 120000,
  max_duration_ms: 2700000,
  max_tool_retries: 2,
  repeat_detection: { window: 6, identical_action_limit: 2 },
  termination: {
    require_structured_signal: true,
    require_external_verification: true,
    budget_ceiling: "hard",
  },
} as const;

type BudgetField = "max_steps" | "max_tokens" | "max_duration_ms" | "max_tool_retries";

/** Weakening overrides (raising a ceiling, relaxing termination) need this. */
export interface LoopPolicyOverrides {
  readonly max_steps?: number;
  readonly max_tokens?: number;
  readonly max_duration_ms?: number;
  readonly max_tool_retries?: number;
  readonly termination?: {
    readonly require_structured_signal?: boolean;
    readonly require_external_verification?: boolean;
    readonly budget_ceiling?: BudgetCeilingMode;
  };
}

export interface LoopPolicyRequest {
  readonly overrides?: LoopPolicyOverrides;
  /** Digest of the policy authorization that permits a weakening override. */
  readonly authorization_digest?: string;
}

function policyBoolean(effective: EffectivePolicy, path: string): boolean | undefined {
  const field = effective.fields.find((candidate) => candidate.path === path);
  if (field === undefined || typeof field.value !== "boolean") return undefined;
  return field.value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Structural validation for a resolved or persisted LoopPolicy. */
export function isLoopPolicy(value: unknown): value is LoopPolicy {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as LoopPolicy;
  const repeat = policy.repeat_detection;
  const termination = policy.termination;
  return (
    Number.isInteger(policy.max_steps) &&
    policy.max_steps >= 1 &&
    Number.isInteger(policy.max_tokens) &&
    policy.max_tokens >= 1 &&
    Number.isInteger(policy.max_duration_ms) &&
    policy.max_duration_ms >= 1 &&
    positiveInteger(policy.max_tool_retries) &&
    typeof repeat === "object" &&
    repeat !== null &&
    Number.isInteger(repeat.window) &&
    repeat.window >= 1 &&
    Number.isInteger(repeat.identical_action_limit) &&
    repeat.identical_action_limit >= 2 &&
    typeof termination === "object" &&
    termination !== null &&
    typeof termination.require_structured_signal === "boolean" &&
    typeof termination.require_external_verification === "boolean" &&
    (BUDGET_CEILING_MODES as readonly string[]).includes(termination.budget_ceiling) &&
    typeof policy.effective_policy_digest === "string" &&
    /^[a-f0-9]{64}$/u.test(policy.effective_policy_digest) &&
    typeof policy.digest === "string" &&
    /^[a-f0-9]{64}$/u.test(policy.digest)
  );
}

export function assertLoopPolicy(value: unknown): asserts value is LoopPolicy {
  if (!isLoopPolicy(value)) {
    throw new LoopError("invalid_loop_policy", "LoopPolicy failed structural validation");
  }
}

function resolveBudget(
  effective: EffectivePolicy,
  name: BudgetField,
  fallback: number,
  override: number | undefined,
  authorized: boolean,
): number {
  const declared = policyNumber(effective, `loop.${name}`) ?? fallback;
  const minimum = name === "max_tool_retries" ? 0 : 1;
  let value = declared;
  if (override !== undefined) {
    if (!positiveInteger(override) || override < minimum) {
      throw new LoopError(
        "invalid_loop_policy",
        `loop policy override ${name} must be an integer >= ${String(minimum)}`,
      );
    }
    if (override > declared && !authorized) {
      throw new PolicyError(
        "capability_expansion",
        `raising loop ceiling ${name} from ${String(declared)} to ${String(override)} requires ` +
          "a policy authorization; no actor may raise its own limit",
      );
    }
    value = override;
  }
  // The installation-level maximum bounds every layer; clamping down never
  // needs approval, so an authorized raise can never exceed it either.
  const ceiling = policyNumber(effective, `loop.ceiling.${name}`);
  if (ceiling !== undefined && value > ceiling) value = ceiling;
  return value;
}

function resolveTermination(
  effective: EffectivePolicy,
  overrides: LoopPolicyOverrides["termination"],
  authorized: boolean,
): TerminationPolicy {
  const defaults = GENERIC_PACK_LOOP_DEFAULTS.termination;
  const base: TerminationPolicy = {
    require_structured_signal:
      policyBoolean(effective, "loop.termination.require_structured_signal") ??
      defaults.require_structured_signal,
    require_external_verification:
      policyBoolean(effective, "loop.termination.require_external_verification") ??
      defaults.require_external_verification,
    budget_ceiling:
      policyString(effective, "loop.termination.budget_ceiling") === "soft" ? "soft" : "hard",
  };
  if (overrides === undefined) return base;
  const next: TerminationPolicy = {
    require_structured_signal:
      overrides.require_structured_signal ?? base.require_structured_signal,
    require_external_verification:
      overrides.require_external_verification ?? base.require_external_verification,
    budget_ceiling: overrides.budget_ceiling ?? base.budget_ceiling,
  };
  const weakened =
    (base.require_structured_signal && !next.require_structured_signal) ||
    (base.require_external_verification && !next.require_external_verification) ||
    (base.budget_ceiling === "hard" && next.budget_ceiling === "soft");
  if (weakened && !authorized) {
    throw new PolicyError(
      "capability_expansion",
      "relaxing loop termination requirements requires a policy authorization",
    );
  }
  return next;
}

/**
 * Resolve the effective LoopPolicy for one run. Lowering any ceiling or
 * tightening any termination rule is always allowed; anything that weakens
 * governance requires `authorization_digest`, and every budget is finally
 * clamped to the installation-level maximum. Repeat detection has no
 * override channel at all.
 */
export function resolveLoopPolicy(
  effective: EffectivePolicy,
  request: LoopPolicyRequest = {},
): LoopPolicy {
  const authorized = request.authorization_digest !== undefined;
  const overrides = request.overrides ?? {};
  const parts = {
    max_steps: resolveBudget(
      effective,
      "max_steps",
      GENERIC_PACK_LOOP_DEFAULTS.max_steps,
      overrides.max_steps,
      authorized,
    ),
    max_tokens: resolveBudget(
      effective,
      "max_tokens",
      GENERIC_PACK_LOOP_DEFAULTS.max_tokens,
      overrides.max_tokens,
      authorized,
    ),
    max_duration_ms: resolveBudget(
      effective,
      "max_duration_ms",
      GENERIC_PACK_LOOP_DEFAULTS.max_duration_ms,
      overrides.max_duration_ms,
      authorized,
    ),
    max_tool_retries: resolveBudget(
      effective,
      "max_tool_retries",
      GENERIC_PACK_LOOP_DEFAULTS.max_tool_retries,
      overrides.max_tool_retries,
      authorized,
    ),
    repeat_detection: {
      window:
        policyNumber(effective, "loop.repeat_detection.window") ??
        GENERIC_PACK_LOOP_DEFAULTS.repeat_detection.window,
      identical_action_limit:
        policyNumber(effective, "loop.repeat_detection.identical_action_limit") ??
        GENERIC_PACK_LOOP_DEFAULTS.repeat_detection.identical_action_limit,
    },
    termination: resolveTermination(effective, overrides.termination, authorized),
    effective_policy_digest: effective.digest,
  };
  const candidate = { ...parts, digest: "" };
  if (!isLoopPolicy({ ...candidate, digest: "0".repeat(64) })) {
    throw new LoopError(
      "invalid_loop_policy",
      "resolved loop policy failed validation (check loop.* policy field values)",
    );
  }
  return { ...parts, digest: contentDigest(parts) };
}
