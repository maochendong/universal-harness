import { PROTOCOL_1_2_VERSION } from "../protocol.js";
import type { CollaborationRecord, ControlRecord } from "../schema/collaboration.js";
import { sealRecordEnvelope } from "../schema/envelope.js";

/**
 * Deterministic builders, semantic invariants and reader-version gates for
 * the five Protocol 1.2 collaboration records. Builders always seal the
 * envelope themselves: a caller-supplied `protocol_version` or
 * `record_digest` is recomputed, never trusted.
 */
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

/** Typed fail-closed error for readers that cannot project a newer record. */
export class ProtocolProjectionError extends Error {
  readonly kind = "protocol_upgrade_required" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProtocolProjectionError";
  }
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function parseVersion(version: string): readonly [number, number, number] {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) {
    throw new ProtocolProjectionError(
      `protocol_upgrade_required: unparseable protocol version ${JSON.stringify(version)}`,
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = a[index] as number;
    const rightPart = b[index] as number;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/**
 * Reader gate for Protocol 1.2 compatibility (design §19.1): a reader always
 * projects records at or below its own version, and an older reader fails
 * closed with `protocol_upgrade_required` only when the newer record is
 * authoritative. Non-authoritative newer data (derived read models) never
 * blocks an old reader.
 */
export function assertProtocolReaderCanProject(options: {
  readonly readerVersion: string;
  readonly recordVersion: string;
  readonly authoritative: boolean;
}): void {
  if (!options.authoritative) return;
  if (compareVersions(options.recordVersion, options.readerVersion) > 0) {
    throw new ProtocolProjectionError(
      `protocol_upgrade_required: record requires reader ${options.recordVersion}, active reader is ${options.readerVersion}`,
    );
  }
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
