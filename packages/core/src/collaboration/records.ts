import { PROTOCOL_1_2_VERSION } from "../protocol.js";
import type { CollaborationRecord, ControlRecord } from "../schema/collaboration.js";
import { sealRecordEnvelope } from "../schema/envelope.js";

/**
 * Deterministic builders and semantic invariants for the five Protocol 1.2
 * collaboration records. Builders always seal the envelope themselves: a
 * caller-supplied `protocol_version` or `record_digest` is recomputed, never
 * trusted. The reader-version gate is generic protocol machinery and lives
 * in `protocol.js`; it is re-exported here so existing importers keep working.
 */
export { ProtocolProjectionError, assertProtocolReaderCanProject } from "../protocol.js";

export type CollaborationRecordDraft = {
  [K in CollaborationRecord["record_kind"]]: Omit<
    Extract<CollaborationRecord, { record_kind: K }>,
    "protocol_version" | "record_digest"
  >;
}[CollaborationRecord["record_kind"]];

export function buildCollaborationRecord<T extends CollaborationRecordDraft>(
  draft: T,
): T & { readonly protocol_version: typeof PROTOCOL_1_2_VERSION; readonly record_digest: string } {
  return sealRecordEnvelope({ ...draft, protocol_version: PROTOCOL_1_2_VERSION });
}

export class CollaborationChainError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid control record chain: ${reason}`);
    this.name = "CollaborationChainError";
    this.reason = reason;
  }
}

/**
 * Control Ref chain invariant: the first record carries no previous digest,
 * and every later record links the exact prior `record_digest` with a
 * `control_sequence` incremented by one. Verification is over the records as
 * given; callers pass the complete chain read from the Control Ref.
 */
export function assertControlChain(records: readonly ControlRecord[]): void {
  const first = records[0];
  if (first === undefined) {
    throw new CollaborationChainError("chain is empty");
  }
  if (first.previous_control_record_digest !== undefined) {
    throw new CollaborationChainError(
      `first record ${first.record_digest} must not carry previous_control_record_digest`,
    );
  }
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1] as ControlRecord;
    const current = records[index] as ControlRecord;
    if (current.control_sequence !== previous.control_sequence + 1) {
      throw new CollaborationChainError(
        `control_sequence must increase by one: ${previous.control_sequence} then ${current.control_sequence}`,
      );
    }
    if (current.previous_control_record_digest !== previous.record_digest) {
      throw new CollaborationChainError(
        `record at control_sequence ${current.control_sequence} does not link the exact previous record_digest`,
      );
    }
  }
}
