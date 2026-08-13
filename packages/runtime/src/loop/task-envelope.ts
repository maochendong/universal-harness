import { contentDigest } from "@universal-harness-internal/core";

import { POLICY_RISKS, type PolicyRisk } from "../policy/action.js";
import type { GrantedTool } from "../policy/capability-grant.js";
import { normalizeRepoRelativePath } from "../policy/path-boundary.js";
import { isLoopPolicy, LoopError, type LoopPolicy } from "./policy.js";

/**
 * Task Envelope (design 13.2): the executable node contract handed to an
 * AgentAdapter for one managed run. It binds the task to its plan, iteration,
 * repository and baseline, carries the immutable context and state contract,
 * the named tool capabilities, the approval bindings and the LoopPolicy.
 * Envelopes are immutable and content-digested; the adapter never receives
 * authority beyond what the envelope plus its capability grant describe.
 */
export const EXTERNAL_SIDE_EFFECT_POLICIES = ["forbidden", "approval_required", "allowed"] as const;

export type ExternalSideEffectPolicy = (typeof EXTERNAL_SIDE_EFFECT_POLICIES)[number];

export const STALE_INPUT_BEHAVIORS = ["block", "recompile"] as const;

export type StaleInputBehavior = (typeof STALE_INPUT_BEHAVIORS)[number];

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export interface TaskEnvelope {
  readonly task_id: string;
  readonly plan_id: string;
  readonly iteration_id: string;
  readonly repository_id: string;
  readonly baseline_id: string;
  readonly objective: string;
  readonly expected_output: string;
  readonly acceptance_criteria: readonly string[];
  readonly dependency_task_ids: readonly string[];
  readonly required_gate_ids: readonly string[];
  /** Input node id -> revision the task was compiled against. */
  readonly input_node_revisions: Readonly<Record<string, number>>;
  readonly context_bundle_id: string;
  readonly context_bundle_digest: string;
  readonly protected_context_fields: readonly string[];
  readonly allowed_read_paths: readonly string[];
  readonly proposed_write_paths: readonly string[];
  readonly state_read_fields: readonly string[];
  readonly state_proposal_fields: readonly string[];
  /** Named Tool Registry capabilities with their parameter/resource limits. */
  readonly tools: readonly GrantedTool[];
  readonly risk: PolicyRisk;
  readonly required_approval_digests: readonly string[];
  readonly external_side_effect: ExternalSideEffectPolicy;
  readonly idempotency_scope: string;
  readonly loop_policy: LoopPolicy;
  readonly baseline_commit: string;
  readonly input_digest: string;
  readonly stale_input_behavior: StaleInputBehavior;
  readonly digest: string;
}

export type TaskEnvelopeSpec = Omit<TaskEnvelope, "digest">;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isDigestArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && DIGEST_PATTERN.test(entry))
  );
}

function isGrantedToolArray(value: unknown): value is GrantedTool[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        isNonEmptyString((entry as GrantedTool).name),
    )
  );
}

function isNodeRevisionMap(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((revision) => Number.isInteger(revision) && revision >= 0);
}

/** Structural validation for a TaskEnvelope read back from a record. */
export function isTaskEnvelope(value: unknown): value is TaskEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as TaskEnvelope;
  return (
    isNonEmptyString(envelope.task_id) &&
    isNonEmptyString(envelope.plan_id) &&
    isNonEmptyString(envelope.iteration_id) &&
    isNonEmptyString(envelope.repository_id) &&
    isNonEmptyString(envelope.baseline_id) &&
    isNonEmptyString(envelope.objective) &&
    isNonEmptyString(envelope.expected_output) &&
    isStringArray(envelope.acceptance_criteria) &&
    isStringArray(envelope.dependency_task_ids) &&
    isStringArray(envelope.required_gate_ids) &&
    isNodeRevisionMap(envelope.input_node_revisions) &&
    isNonEmptyString(envelope.context_bundle_id) &&
    DIGEST_PATTERN.test(envelope.context_bundle_digest) &&
    isStringArray(envelope.protected_context_fields) &&
    isStringArray(envelope.allowed_read_paths) &&
    isStringArray(envelope.proposed_write_paths) &&
    isStringArray(envelope.state_read_fields) &&
    isStringArray(envelope.state_proposal_fields) &&
    isGrantedToolArray(envelope.tools) &&
    (POLICY_RISKS as readonly string[]).includes(envelope.risk) &&
    isDigestArray(envelope.required_approval_digests) &&
    (EXTERNAL_SIDE_EFFECT_POLICIES as readonly string[]).includes(envelope.external_side_effect) &&
    isNonEmptyString(envelope.idempotency_scope) &&
    isLoopPolicy(envelope.loop_policy) &&
    isNonEmptyString(envelope.baseline_commit) &&
    DIGEST_PATTERN.test(envelope.input_digest) &&
    (STALE_INPUT_BEHAVIORS as readonly string[]).includes(envelope.stale_input_behavior) &&
    typeof envelope.digest === "string" &&
    DIGEST_PATTERN.test(envelope.digest)
  );
}

function envelopeDigest(spec: TaskEnvelopeSpec): string {
  return contentDigest({
    task_id: spec.task_id,
    plan_id: spec.plan_id,
    iteration_id: spec.iteration_id,
    repository_id: spec.repository_id,
    baseline_id: spec.baseline_id,
    objective: spec.objective,
    expected_output: spec.expected_output,
    acceptance_criteria: spec.acceptance_criteria,
    dependency_task_ids: spec.dependency_task_ids,
    required_gate_ids: spec.required_gate_ids,
    input_node_revisions: spec.input_node_revisions,
    context_bundle_id: spec.context_bundle_id,
    context_bundle_digest: spec.context_bundle_digest,
    protected_context_fields: spec.protected_context_fields,
    allowed_read_paths: spec.allowed_read_paths,
    proposed_write_paths: spec.proposed_write_paths,
    state_read_fields: spec.state_read_fields,
    state_proposal_fields: spec.state_proposal_fields,
    tools: spec.tools,
    risk: spec.risk,
    required_approval_digests: spec.required_approval_digests,
    external_side_effect: spec.external_side_effect,
    idempotency_scope: spec.idempotency_scope,
    loop_policy: spec.loop_policy,
    baseline_commit: spec.baseline_commit,
    input_digest: spec.input_digest,
    stale_input_behavior: spec.stale_input_behavior,
  });
}

/**
 * Build an immutable, content-digested envelope. Path sets are normalized to
 * canonical repository-relative form and tool entries are sorted by name so
 * the digest is stable regardless of assembly order.
 */
export function buildTaskEnvelope(
  spec: Omit<TaskEnvelopeSpec, "allowed_read_paths" | "proposed_write_paths" | "tools"> & {
    readonly allowed_read_paths: readonly string[];
    readonly proposed_write_paths: readonly string[];
    readonly tools: readonly GrantedTool[];
  },
): TaskEnvelope {
  const normalized: TaskEnvelopeSpec = {
    ...spec,
    allowed_read_paths: [...new Set(spec.allowed_read_paths.map(normalizeRepoRelativePath))].sort(),
    proposed_write_paths: [
      ...new Set(spec.proposed_write_paths.map(normalizeRepoRelativePath)),
    ].sort(),
    tools: [...spec.tools].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
  };
  const envelope: TaskEnvelope = { ...normalized, digest: envelopeDigest(normalized) };
  if (!isTaskEnvelope(envelope)) {
    throw new LoopError(
      "invalid_task_envelope",
      `task envelope for ${spec.task_id} failed structural validation`,
    );
  }
  return envelope;
}
