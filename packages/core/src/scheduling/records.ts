import { PROTOCOL_1_3_VERSION } from "../protocol.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import {
  TaskLeaseRecordSchema,
  WaveIntegrationRecordSchema,
  type SchedulingRecord,
  type TaskLeaseRecord,
  type WaveIntegrationRecord,
} from "../schema/scheduling.js";
import { compileSchemaValidator, type CompiledSchemaValidator } from "../schema/validator.js";

/**
 * Deterministic builders and semantic invariants for the two Protocol 1.3
 * scheduling records. Builders always seal the envelope themselves: a
 * caller-supplied `protocol_version`, `record_kind` or `record_digest` is
 * recomputed, never trusted. `assertSchedulingRecordSemantics` runs the full
 * schema plus cross-field invariants and is called both on construction and
 * on read, so a syntactically valid but semantically impossible chain fails
 * closed in both directions.
 */
export class SchedulingRecordError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid scheduling record: ${reason}`);
    this.name = "SchedulingRecordError";
    this.reason = reason;
  }
}

const TERMINAL_LEASE_STATES = ["released", "expired", "revoked"] as const;

const validators: Record<SchedulingRecord["record_kind"], CompiledSchemaValidator> = {
  task_lease: compileSchemaValidator(TaskLeaseRecordSchema),
  wave_integration: compileSchemaValidator(WaveIntegrationRecordSchema),
};

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new SchedulingRecordError(`${field} must not contain duplicates`);
  }
}

function assertTaskLeaseSemantics(record: TaskLeaseRecord): void {
  if (!Number.isInteger(record.fencing_token) || record.fencing_token < 1) {
    throw new SchedulingRecordError(
      `fencing_token must be a positive integer: ${record.fencing_token}`,
    );
  }
  if (
    (TERMINAL_LEASE_STATES as readonly string[]).includes(record.state) &&
    record.previous_lease_record_digest === undefined
  ) {
    throw new SchedulingRecordError(
      `terminal state ${record.state} requires previous_lease_record_digest`,
    );
  }
  if (
    record.consumed_budget.steps > record.reserved_budget.steps ||
    record.consumed_budget.tokens > record.reserved_budget.tokens
  ) {
    throw new SchedulingRecordError("consumed_budget must not exceed reserved_budget");
  }
  assertUnique(record.approval_digests, "approval_digests");
}

function assertWaveIntegrationSemantics(record: WaveIntegrationRecord): void {
  if (!Number.isInteger(record.wave_index) || record.wave_index < 0) {
    throw new SchedulingRecordError(
      `wave_index must be a non-negative integer: ${record.wave_index}`,
    );
  }
  if (record.task_ids.length === 0) {
    throw new SchedulingRecordError("task_ids must not be empty");
  }
  assertUnique(record.task_ids, "task_ids");
  assertUnique(record.task_lease_digests, "task_lease_digests");
  assertUnique(record.task_evidence_digests, "task_evidence_digests");
  assertUnique(record.candidate_gate_evidence_digests, "candidate_gate_evidence_digests");
  assertUnique(record.wave_gate_evidence_digests, "wave_gate_evidence_digests");
  assertUnique(record.approval_digests, "approval_digests");
}

/**
 * Fail-closed validation of a scheduling record: the strict 1.3 schema first,
 * then the cross-field invariants the schema cannot express (lease-chain
 * links, fencing token positivity, consumed-within-reserved budget, unique
 * Plan-ordered arrays).
 */
export function assertSchedulingRecordSemantics(record: SchedulingRecord): void {
  // `record_kind` widens to `string` through the envelope schema cast, so the
  // map lookup is the fail-closed guard and the dispatch below re-narrows.
  const validator: CompiledSchemaValidator | undefined = validators[record.record_kind];
  if (validator === undefined) {
    throw new SchedulingRecordError(
      `unknown scheduling record kind: ${String(record.record_kind)}`,
    );
  }
  const result = validator(record);
  if (!result.valid) {
    const detail = result.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new SchedulingRecordError(detail);
  }
  if (record.record_kind === "task_lease") {
    assertTaskLeaseSemantics(record as TaskLeaseRecord);
  } else {
    assertWaveIntegrationSemantics(record as WaveIntegrationRecord);
  }
}

export type TaskLeaseRecordDraft = Omit<
  TaskLeaseRecord,
  "protocol_version" | "record_kind" | "record_digest"
>;

export function buildTaskLeaseRecord(draft: TaskLeaseRecordDraft): TaskLeaseRecord {
  const record = sealRecordEnvelope({
    ...draft,
    protocol_version: PROTOCOL_1_3_VERSION,
    record_kind: "task_lease" as const,
  });
  assertSchedulingRecordSemantics(record);
  return record;
}

export type WaveIntegrationRecordDraft = Omit<
  WaveIntegrationRecord,
  "protocol_version" | "record_kind" | "record_digest"
>;

export function buildWaveIntegrationRecord(
  draft: WaveIntegrationRecordDraft,
): WaveIntegrationRecord {
  const record = sealRecordEnvelope({
    ...draft,
    protocol_version: PROTOCOL_1_3_VERSION,
    record_kind: "wave_integration" as const,
  });
  assertSchedulingRecordSemantics(record);
  return record;
}
