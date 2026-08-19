import { Type, type TLiteral, type TProperties, type TObject } from "@sinclair/typebox";

import { contentDigest } from "../identity/digest.js";
import { PROTOCOL_1_1_VERSION, isKnownProtocol } from "../protocol.js";
import { DigestSchema, strictObject } from "./common.js";

/**
 * Shared envelope for Protocol 1.1 domain records (Profile, CapabilityPlan,
 * Capture, DesignSet, TDD, model invocation, ...). Every such record carries a
 * pinned `protocol_version`, a snake_case `record_kind` discriminator and a
 * `record_digest` over the canonical form of every other field. Domain tasks
 * extend the envelope with their own properties; this module owns only the
 * convention, never any domain semantics.
 */
export const RECORD_KIND_PATTERN = "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$" as const;
export const RECORD_DIGEST_FIELD = "record_digest" as const;

const RECORD_KIND_REGEX = new RegExp(RECORD_KIND_PATTERN);
const DIGEST_REGEX = /^[a-f0-9]{64}$/u;

export class RecordEnvelopeError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid record envelope: ${reason}`);
    this.name = "RecordEnvelopeError";
    this.reason = reason;
  }
}

/** Envelope properties with the protocol version and record kind pinned as literals. */
export function recordEnvelopeProperties(recordKind: string): {
  protocol_version: TLiteral<typeof PROTOCOL_1_1_VERSION>;
  record_kind: TLiteral<string>;
} {
  if (!RECORD_KIND_REGEX.test(recordKind)) {
    throw new RecordEnvelopeError(`record kind must be snake_case: ${recordKind}`);
  }
  return {
    protocol_version: Type.Literal(PROTOCOL_1_1_VERSION),
    record_kind: Type.Literal(recordKind),
  };
}

/** Strict record schema: envelope plus domain properties plus the digest field. */
export function recordEnvelopeSchema<T extends TProperties>(
  recordKind: string,
  properties: T,
): TObject<
  T & {
    protocol_version: TLiteral<typeof PROTOCOL_1_1_VERSION>;
    record_kind: TLiteral<string>;
    record_digest: typeof DigestSchema;
  }
> {
  // The spread of the generic `T` computes the same property set at runtime;
  // the intersection in the return type is the statically checkable form.
  return strictObject({
    ...recordEnvelopeProperties(recordKind),
    ...properties,
    [RECORD_DIGEST_FIELD]: DigestSchema,
  }) as unknown as TObject<
    T & {
      protocol_version: TLiteral<typeof PROTOCOL_1_1_VERSION>;
      record_kind: TLiteral<string>;
      record_digest: typeof DigestSchema;
    }
  >;
}

/** SHA-256 over the canonical record with the digest field itself excluded. */
export function recordDigestOf(record: Record<string, unknown>): string {
  const semantic = { ...record };
  delete semantic[RECORD_DIGEST_FIELD];
  return contentDigest(semantic);
}

/** Append the record digest computed over all other fields. */
export function sealRecordEnvelope<T extends Record<string, unknown>>(
  record: T,
): T & { record_digest: string } {
  return { ...record, record_digest: recordDigestOf(record) };
}

/**
 * Fail-closed envelope check: unknown protocol versions, malformed record
 * kinds, missing or malformed digests, non-JSON payloads and any post-seal
 * tampering all verify as false rather than throwing.
 */
export function verifyRecordEnvelope(record: Record<string, unknown>): boolean {
  try {
    if (typeof record.protocol_version !== "string" || !isKnownProtocol(record.protocol_version)) {
      return false;
    }
    if (typeof record.record_kind !== "string" || !RECORD_KIND_REGEX.test(record.record_kind)) {
      return false;
    }
    const digest = record[RECORD_DIGEST_FIELD];
    return (
      typeof digest === "string" && DIGEST_REGEX.test(digest) && recordDigestOf(record) === digest
    );
  } catch {
    return false;
  }
}
