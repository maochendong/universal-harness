import { contentDigest } from "@universal-harness-internal/core";

/**
 * Normalized policy action (design 6, 13.5 and 14). Authorization is decided
 * per action -- kind, normalized parameters, resource, phase, risk, approval
 * binding and adapter control profile -- never from the adapter or agent
 * identity alone. Tool output, retrieved documents, repository content and
 * provider output are untrusted context: they may request ordinary actions,
 * but they can never carry capability escalation.
 */
export const POLICY_ACTION_KINDS = [
  "read_path",
  "write_path",
  "invoke_tool",
  "propose_state",
  "submit_evidence",
  "approve",
  "accept_evidence",
  "change_policy",
  "register_tool",
  "grant_path",
] as const;

export type PolicyActionKind = (typeof POLICY_ACTION_KINDS)[number];

export const ACTOR_KINDS = ["harness", "human", "adapter", "agent"] as const;

export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * `control_plane` actions originate from the Harness itself or an explicit
 * human decision; `prompt` actions are carried by untrusted context (model
 * completions, tool output, retrieved or repository content).
 */
export const ACTION_ORIGINS = ["control_plane", "prompt"] as const;

export type ActionOrigin = (typeof ACTION_ORIGINS)[number];

export const POLICY_RISKS = ["low", "medium", "high", "critical"] as const;

export type PolicyRisk = (typeof POLICY_RISKS)[number];

export const CONTROL_LEVELS = ["managed", "delegated", "manual"] as const;

export type ControlLevel = (typeof CONTROL_LEVELS)[number];

export const TRAJECTORY_VISIBILITIES = ["full", "summarized", "external-only"] as const;

export type TrajectoryVisibility = (typeof TRAJECTORY_VISIBILITIES)[number];

/** Control profile declared by an AgentAdapter manifest (design 13.2). */
export interface AdapterControlProfile {
  readonly control: ControlLevel;
  readonly trajectory_visibility: TrajectoryVisibility;
  readonly usage_metering: boolean;
  readonly side_effect_interception: boolean;
}

/**
 * Escalation kinds an agent or adapter can never be granted and untrusted
 * context can never request: modifying policy, registering tools, granting
 * paths, approving and accepting evidence all stay with the control plane.
 */
export const ESCALATION_ACTION_KINDS = [
  "approve",
  "accept_evidence",
  "change_policy",
  "register_tool",
  "grant_path",
] as const satisfies readonly PolicyActionKind[];

export interface PolicyAction {
  readonly kind: PolicyActionKind;
  /** Stable actor id; identity alone never authorizes anything. */
  readonly actor: string;
  readonly actor_kind: ActorKind;
  readonly origin: ActionOrigin;
  readonly phase: string;
  /** Tool name, repository-relative path or state field the action targets. */
  readonly resource?: string;
  /** Normalized plain-JSON parameters (deep-validated, digest-stable). */
  readonly parameters: Record<string, unknown>;
  readonly risk: PolicyRisk;
  /** Digest of the approval this action claims; never turns deny into allow. */
  readonly approval_digest?: string;
  readonly control_profile?: AdapterControlProfile;
}

export const POLICY_ERROR_KINDS = [
  "invalid_action",
  "invalid_policy",
  "policy_conflict",
  "capability_expansion",
  "boundary_violation",
] as const;

export type PolicyErrorKind = (typeof POLICY_ERROR_KINDS)[number];

export class PolicyError extends Error {
  readonly kind: PolicyErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: PolicyErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PolicyError";
    this.kind = kind;
    if (details !== undefined) this.details = details;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-validate action parameters to plain JSON so the digest is stable and
 * no function, class instance or undefined value can smuggle behavior into a
 * decision. Key order is normalized by the canonical JSON writer at digest
 * time, so logically equal parameters always produce the same digest.
 */
function normalizeJsonValue(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new PolicyError("invalid_action", `parameter ${path} is not a finite number`);
      }
      return value === 0 ? 0 : value;
    case "object": {
      if (Array.isArray(value)) {
        return value.map((item, index) => normalizeJsonValue(item, `${path}[${String(index)}]`));
      }
      if (!isPlainObject(value)) {
        throw new PolicyError(
          "invalid_action",
          `parameter ${path} must be plain JSON, not a class instance`,
        );
      }
      const normalized: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) {
          throw new PolicyError("invalid_action", `parameter ${path}.${key} is undefined`);
        }
        normalized[key] = normalizeJsonValue(entry, `${path}.${key}`);
      }
      return normalized;
    }
    default:
      throw new PolicyError(
        "invalid_action",
        `parameter ${path} has unsupported type ${typeof value}`,
      );
  }
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new PolicyError("invalid_action", `action ${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PolicyError("invalid_action", `action ${field} must be a non-empty string`);
  }
  return value;
}

function readControlProfile(raw: unknown): AdapterControlProfile {
  if (!isPlainObject(raw)) {
    throw new PolicyError("invalid_action", "action control_profile must be an object");
  }
  return {
    control: readEnum(raw.control, CONTROL_LEVELS, "control_profile.control"),
    trajectory_visibility: readEnum(
      raw.trajectory_visibility,
      TRAJECTORY_VISIBILITIES,
      "control_profile.trajectory_visibility",
    ),
    usage_metering: raw.usage_metering === true,
    side_effect_interception: raw.side_effect_interception === true,
  };
}

/**
 * Validate and normalize a raw action request. Untrusted input fails with a
 * typed PolicyError before any decision is evaluated, so a malformed request
 * can never be decided, let alone allowed.
 */
export function normalizeAction(raw: unknown): PolicyAction {
  if (!isPlainObject(raw)) {
    throw new PolicyError("invalid_action", "an action request must be an object");
  }
  const kind = readEnum(raw.kind, POLICY_ACTION_KINDS, "kind");
  const parameters =
    raw.parameters === undefined
      ? {}
      : (normalizeJsonValue(raw.parameters, "parameters") as Record<string, unknown>);
  if (!isPlainObject(parameters)) {
    throw new PolicyError("invalid_action", "action parameters must be an object");
  }
  const action: PolicyAction = {
    kind,
    actor: readNonEmptyString(raw.actor, "actor"),
    actor_kind: readEnum(raw.actor_kind, ACTOR_KINDS, "actor_kind"),
    origin: readEnum(raw.origin, ACTION_ORIGINS, "origin"),
    phase: readNonEmptyString(raw.phase, "phase"),
    ...(raw.resource === undefined
      ? {}
      : { resource: readNonEmptyString(raw.resource, "resource") }),
    parameters,
    risk: readEnum(raw.risk, POLICY_RISKS, "risk"),
    ...(raw.approval_digest === undefined
      ? {}
      : { approval_digest: readNonEmptyString(raw.approval_digest, "approval_digest") }),
    ...(raw.control_profile === undefined
      ? {}
      : { control_profile: readControlProfile(raw.control_profile) }),
  };
  return action;
}

/** Content digest of the normalized action; stable across process runs. */
export function actionDigest(action: PolicyAction): string {
  return contentDigest({
    kind: action.kind,
    actor: action.actor,
    actor_kind: action.actor_kind,
    origin: action.origin,
    phase: action.phase,
    resource: action.resource ?? null,
    parameters: action.parameters,
    risk: action.risk,
    approval_digest: action.approval_digest ?? null,
    control_profile: action.control_profile ?? null,
  });
}

/** Rank used to compare risk levels; higher means riskier. */
export function riskRank(risk: PolicyRisk): number {
  return POLICY_RISKS.indexOf(risk);
}
