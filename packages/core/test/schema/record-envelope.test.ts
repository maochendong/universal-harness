import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { IdentifierSchema } from "../../src/schema/common.js";
import {
  RECORD_KIND_PATTERN,
  recordDigestOf,
  recordEnvelopeProperties,
  recordEnvelopeSchema,
  sealRecordEnvelope,
  verifyRecordEnvelope,
} from "../../src/schema/envelope.js";
import { compileSchemaValidator } from "../../src/schema/registry.js";

const ExampleRecordSchema = recordEnvelopeSchema("example_record", {
  example_record_id: IdentifierSchema,
  project_id: IdentifierSchema,
  summary: Type.String({ minLength: 1 }),
});

const validate = compileSchemaValidator(ExampleRecordSchema);

function withoutRecordDigest(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.record_digest;
  return copy;
}

function exampleRecord() {
  return {
    protocol_version: "1.1.0",
    record_kind: "example_record",
    example_record_id: "example_01K1ABCDEFGHIJKLMNO",
    project_id: "project_01K1ABCDEFGHIJKLMNO",
    summary: "example",
  };
}

describe("record envelope schema", () => {
  it("pins the protocol version literal, record kind literal and record digest", () => {
    const properties = recordEnvelopeProperties("example_record");
    expect(properties.protocol_version).toMatchObject({ const: "1.1.0" });
    expect(properties.record_kind).toMatchObject({ const: "example_record" });

    expect(validate(sealRecordEnvelope(exampleRecord()))).toEqual({ valid: true, errors: [] });
  });

  it("rejects a missing or foreign protocol version, record kind, digest or unknown field", () => {
    const sealed = sealRecordEnvelope(exampleRecord());
    expect(validate({ ...sealed, protocol_version: "1.0.0" })).toMatchObject({ valid: false });
    expect(validate({ ...sealed, protocol_version: "9.9.9" })).toMatchObject({ valid: false });
    expect(validate({ ...sealed, record_kind: "other_record" })).toMatchObject({ valid: false });
    expect(validate({ ...sealed, unexpected: true })).toMatchObject({ valid: false });

    expect(validate(withoutRecordDigest(sealed))).toMatchObject({ valid: false });
  });

  it("rejects record kinds that violate the snake_case convention", () => {
    expect(() => recordEnvelopeProperties("ExampleRecord")).toThrow(/record kind/i);
    expect(() => recordEnvelopeProperties("example-record")).toThrow(/record kind/i);
    expect(RECORD_KIND_PATTERN).toBe("^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$");
  });
});

describe("record digest", () => {
  it("ignores the record_digest field itself", () => {
    const record = exampleRecord();
    expect(recordDigestOf({ ...record, record_digest: "f".repeat(64) })).toBe(
      recordDigestOf(record),
    );
  });

  it("seals a record so the envelope verifies, and detects any later tampering", () => {
    const sealed = sealRecordEnvelope(exampleRecord());
    expect(sealed.record_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyRecordEnvelope(sealed)).toBe(true);

    expect(verifyRecordEnvelope({ ...sealed, summary: "tampered" })).toBe(false);
    expect(verifyRecordEnvelope({ ...sealed, record_digest: "0".repeat(64) })).toBe(false);
    expect(verifyRecordEnvelope({ ...sealed, protocol_version: "9.9.9" })).toBe(false);
    expect(verifyRecordEnvelope({ ...sealed, record_kind: "NotAKind" })).toBe(false);

    expect(verifyRecordEnvelope(withoutRecordDigest(sealed))).toBe(false);
  });

  it("fails closed instead of throwing on non-JSON payloads", () => {
    const sealed = sealRecordEnvelope(exampleRecord());
    expect(
      verifyRecordEnvelope({ ...sealed, summary: Number.NaN } as Record<string, unknown>),
    ).toBe(false);
  });
});
