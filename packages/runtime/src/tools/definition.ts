import { contentDigest } from "@universal-harness-internal/core";

import { POLICY_RISKS, type PolicyRisk } from "../policy/action.js";

/**
 * Versioned Tool Descriptor (design 13.5). Every executable command, script,
 * provider-exposed MCP capability and external API must be registered as an
 * ordinary ToolDefinition before use; MCP capabilities accept exactly the
 * same schema, grant, approval, redaction and reconciliation constraints --
 * M1 implements no MCP transport, discovery or first-party MCP adapter.
 *
 * Descriptors are immutable: registering the same name and version with
 * different content is a typed error, never an overwrite.
 */
export const TOOL_ERROR_KINDS = [
  "invalid_definition",
  "unknown_tool",
  "invalid_input",
  "invalid_output",
  "phase_not_allowed",
  "resource_not_allowed",
  "parameter_out_of_bounds",
  "grant_violation",
  "approval_required",
  "approval_invalid",
  "quota_exceeded",
  "idempotency_key_required",
  "invalid_intent_transition",
  "reconciliation_required",
  "timeout",
  "tool_failed",
  "uncertain_result",
] as const;

export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number];

export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: ToolErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.kind = kind;
    if (details !== undefined) this.details = details;
  }
}

/**
 * `none`: pure computation; `repository`: writes inside the repository
 * boundary; `external`: a side effect the Harness cannot undo, which always
 * requires an idempotency key and an Action Intent (design 13.5).
 */
export const SIDE_EFFECT_CLASSES = ["none", "repository", "external"] as const;

export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

/**
 * `none`: a failed call is never retried; `idempotent_only`: retry is allowed
 * only because the descriptor declares the call idempotent. An uncertain
 * external result is never retried by either class -- it must be reconciled.
 */
export const RETRY_CLASSES = ["none", "idempotent_only"] as const;

export type RetryClass = (typeof RETRY_CLASSES)[number];

/**
 * How an uncertain external result can be reconciled on resume: `provider`
 * exposes a probe that can prove the effect applied or not applied; `manual`
 * always requires human review.
 */
export const RECONCILIATION_MODES = ["provider", "manual"] as const;

export type ReconciliationMode = (typeof RECONCILIATION_MODES)[number];

export const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

const TOOL_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const SECRET_PARAMETER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,127}$/u;

export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** JSON Schema 2020-12 documents, compiled at registration time. */
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  readonly allowed_phases: readonly string[];
  /**
   * Resource patterns: an exact string, or a prefix pattern ending in `*`
   * (e.g. `issue:*`). An empty list means the tool takes no resource.
   */
  readonly resource_patterns: readonly string[];
  /** Per-parameter allow-lists the invocation arguments must stay within. */
  readonly parameter_bounds: Readonly<Record<string, readonly (string | number | boolean)[]>>;
  readonly risk: PolicyRisk;
  readonly side_effect_class: SideEffectClass;
  readonly requires_approval: boolean;
  /** Top-level output fields replaced before output is recorded as evidence. */
  readonly redacted_output_fields: readonly string[];
  /** Parameter names that accept an Environment Secret Reference. */
  readonly secret_parameters: readonly string[];
  readonly timeout_ms: number;
  readonly retry_class: RetryClass;
  readonly max_retries: number;
  /** Quota: maximum invocations of this tool per run. */
  readonly max_invocations_per_run: number;
  readonly idempotent: boolean;
  readonly reconciliation: ReconciliationMode;
  readonly digest: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): ToolError {
  return new ToolError("invalid_definition", message);
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(`tool definition ${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function readStringArray(
  value: unknown,
  field: string,
  options?: { allowEmpty?: boolean },
): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw invalid(`tool definition ${field} must be an array of non-empty strings`);
  }
  if (options?.allowEmpty !== true && value.length === 0) {
    throw invalid(`tool definition ${field} must not be empty`);
  }
  return [...new Set(value as string[])].sort();
}

function readPositiveInteger(
  value: unknown,
  field: string,
  options?: { allowZero?: boolean },
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < (options?.allowZero === true ? 0 : 1)
  ) {
    throw invalid(
      `tool definition ${field} must be a ${options?.allowZero === true ? "non-negative" : "positive"} integer`,
    );
  }
  return value;
}

function readSchema(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalid(`tool definition ${field} must be a JSON Schema object`);
  }
  return value;
}

function readParameterBounds(
  value: unknown,
): Readonly<Record<string, readonly (string | number | boolean)[]>> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw invalid("tool definition parameter_bounds must be an object");
  }
  const bounds: Record<string, readonly (string | number | boolean)[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !Array.isArray(entry) ||
      entry.length === 0 ||
      entry.some(
        (item) => typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean",
      )
    ) {
      throw invalid(`tool definition parameter_bounds.${key} must be a non-empty scalar array`);
    }
    bounds[key] = [...entry];
  }
  return bounds;
}

/** Deterministic version ordering: numeric semver triple, then prerelease tag. */
export function compareToolVersions(left: string, right: string): number {
  const parse = (version: string): readonly number[] =>
    version
      .split("+")[0]
      ?.split("-")[0]
      ?.split(".")
      .map((part) => Number.parseInt(part, 10)) ?? [0, 0, 0];
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Whether a target resource matches the declared patterns: exact match, or a
 * `*` suffix matching any suffix (prefix pattern).
 */
export function resourceMatchesPatterns(patterns: readonly string[], resource: string): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith("*")) {
      if (resource.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === resource) {
      return true;
    }
  }
  return false;
}

/**
 * Validate and normalize a raw Tool Descriptor. Structural violations throw a
 * typed invalid_definition error; the descriptor is refused before it can be
 * registered, so an illegal tool can never be invoked.
 */
export function normalizeToolDefinition(raw: unknown): ToolDefinition {
  if (!isPlainObject(raw)) {
    throw invalid("a tool definition must be an object");
  }
  if (typeof raw.name !== "string" || !TOOL_NAME_PATTERN.test(raw.name)) {
    throw invalid(`tool definition name must match ${TOOL_NAME_PATTERN.source}`);
  }
  if (typeof raw.version !== "string" || !TOOL_VERSION_PATTERN.test(raw.version)) {
    throw invalid("tool definition version must be a semver string");
  }
  if (typeof raw.description !== "string" || raw.description.trim() === "") {
    throw invalid("tool definition description must be a non-empty string");
  }

  const risk = readEnum(raw.risk, POLICY_RISKS, "risk");
  const sideEffectClass = readEnum(raw.side_effect_class, SIDE_EFFECT_CLASSES, "side_effect_class");
  const retryClass = readEnum(raw.retry_class, RETRY_CLASSES, "retry_class");
  const reconciliation = readEnum(raw.reconciliation, RECONCILIATION_MODES, "reconciliation");
  const idempotent = raw.idempotent === true;
  const maxRetries = readPositiveInteger(raw.max_retries ?? 0, "max_retries", { allowZero: true });

  if (retryClass === "none" && maxRetries !== 0) {
    throw invalid('retry_class "none" requires max_retries 0');
  }
  if (retryClass === "idempotent_only" && !idempotent) {
    throw invalid('retry_class "idempotent_only" requires the descriptor to declare idempotent');
  }

  const secretParameters = readStringArray(raw.secret_parameters ?? [], "secret_parameters", {
    allowEmpty: true,
  });
  for (const parameter of secretParameters) {
    if (!SECRET_PARAMETER_PATTERN.test(parameter)) {
      throw invalid(`tool definition secret parameter "${parameter}" is not a legal name`);
    }
  }

  const definition: Omit<ToolDefinition, "digest"> = {
    name: raw.name,
    version: raw.version,
    description: raw.description,
    input_schema: readSchema(raw.input_schema, "input_schema"),
    output_schema: readSchema(raw.output_schema, "output_schema"),
    allowed_phases: readStringArray(raw.allowed_phases, "allowed_phases"),
    resource_patterns: readStringArray(raw.resource_patterns ?? [], "resource_patterns", {
      allowEmpty: true,
    }),
    parameter_bounds: readParameterBounds(raw.parameter_bounds),
    risk,
    side_effect_class: sideEffectClass,
    requires_approval: raw.requires_approval === true,
    redacted_output_fields: readStringArray(
      raw.redacted_output_fields ?? [],
      "redacted_output_fields",
      { allowEmpty: true },
    ),
    secret_parameters: secretParameters,
    timeout_ms: readPositiveInteger(raw.timeout_ms, "timeout_ms"),
    retry_class: retryClass,
    max_retries: maxRetries,
    max_invocations_per_run: readPositiveInteger(
      raw.max_invocations_per_run,
      "max_invocations_per_run",
    ),
    idempotent,
    reconciliation,
  };
  return { ...definition, digest: contentDigest(definition) };
}
