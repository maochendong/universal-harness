import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import {
  DOMAIN_SCHEMA_KEY_PATTERN,
  createDomainSchemaRegistry,
  mergeSchemaDocuments,
} from "../../src/schema/domain-registry.js";
import { recordEnvelopeSchema, sealRecordEnvelope } from "../../src/schema/envelope.js";
import {
  JSON_SCHEMA_DOCUMENTS,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  SCHEMA_EXPORT_DOCUMENTS,
} from "../../src/schema/registry.js";

const ExampleRecordSchema = recordEnvelopeSchema("example_record", {
  example_record_id: Type.String({ minLength: 1 }),
});

function exampleRecord() {
  return {
    protocol_version: "1.1.0",
    record_kind: "example_record",
    example_record_id: "example_01",
  };
}

describe("domain schema registry", () => {
  const registry = createDomainSchemaRegistry({
    protocolVersion: "1.1.0",
    entries: [{ key: "example-record", schema: ExampleRecordSchema }],
  });

  it("validates records against registered schemas", () => {
    expect(registry.has("example-record")).toBe(true);
    expect(registry.keys).toEqual(["example-record"]);
    expect(registry.validate("example-record", sealRecordEnvelope(exampleRecord()))).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      registry.validate("example-record", { ...exampleRecord(), record_digest: "bad" }),
    ).toMatchObject({ valid: false });
  });

  it("fails closed on unregistered schema keys", () => {
    expect(registry.has("other-record")).toBe(false);
    expect(registry.validate("other-record", exampleRecord())).toEqual({
      valid: false,
      errors: [{ instancePath: "", keyword: "schema", message: "unknown schema: other-record" }],
    });
  });

  it("fails closed on records carrying a foreign protocol version", () => {
    expect(
      registry.validate("example-record", {
        ...sealRecordEnvelope(exampleRecord()),
        protocol_version: "1.0.0",
      }),
    ).toMatchObject({ valid: false });
  });

  it("refuses unknown protocols, duplicate keys and malformed keys at registration", () => {
    expect(() => createDomainSchemaRegistry({ protocolVersion: "9.9.9", entries: [] })).toThrow(
      /unknown protocol version/i,
    );
    expect(() =>
      createDomainSchemaRegistry({
        protocolVersion: "1.1.0",
        entries: [
          { key: "example-record", schema: ExampleRecordSchema },
          { key: "example-record", schema: ExampleRecordSchema },
        ],
      }),
    ).toThrow(/duplicate schema key/i);
    expect(() =>
      createDomainSchemaRegistry({
        protocolVersion: "1.1.0",
        entries: [{ key: "ExampleRecord", schema: ExampleRecordSchema }],
      }),
    ).toThrow(/schema key/i);
    expect(DOMAIN_SCHEMA_KEY_PATTERN.test("example-record")).toBe(true);
    expect(DOMAIN_SCHEMA_KEY_PATTERN.test("example_record")).toBe(false);
  });
});

describe("domain schema export boundary", () => {
  const registry = createDomainSchemaRegistry({
    protocolVersion: "1.1.0",
    entries: [{ key: "example-record", schema: ExampleRecordSchema }],
  });

  it("emits JSON Schema 2020-12 documents under the protocol minor namespace", () => {
    const documents = registry.documents();
    expect(Object.keys(documents)).toEqual(["example-record.schema.json"]);
    expect(documents["example-record.schema.json"]).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.universal-harness.dev/1.1/example-record.schema.json",
    });
  });

  it("is deterministic across calls", () => {
    expect(JSON.stringify(registry.documents())).toBe(JSON.stringify(registry.documents()));
  });

  it("fails closed when merged exports would collide", () => {
    const documents = registry.documents();
    expect(() => mergeSchemaDocuments(documents, documents)).toThrow(/duplicate schema document/i);
    expect(mergeSchemaDocuments(documents, { "other.schema.json": {} })).toMatchObject({
      "example-record.schema.json": documents["example-record.schema.json"] as object,
      "other.schema.json": {},
    });
  });
});

describe("protocol 1.1 schema plumbing", () => {
  it("ships an empty 1.1 domain registry until domain tasks register their schemas", () => {
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.protocolVersion).toBe("1.1.0");
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.keys).toEqual([]);
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("project-profile", {})).toMatchObject({
      valid: false,
    });
  });

  it("aggregates export documents without drifting from the M1 baseline", () => {
    expect(SCHEMA_EXPORT_DOCUMENTS).toEqual(JSON_SCHEMA_DOCUMENTS);
  });
});
