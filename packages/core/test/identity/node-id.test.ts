import { describe, expect, it } from "vitest";

import {
  humanNodeId,
  kebabNodeType,
  scannedNodeId,
  ulid,
  uuidv5,
} from "../../src/identity/node-id.js";

describe("uuidv5", () => {
  it("matches the RFC 4122 name-based UUID example", () => {
    expect(uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  it("rejects malformed namespaces", () => {
    expect(() => uuidv5("not-a-uuid", "x")).toThrow(/Invalid UUID/);
  });
});

describe("scanned node ID", () => {
  const identity = {
    project_id: "project_01K1ABCDEFGHIJKLMNOPQRSTUV",
    repository_id: "repository_01K1BBBBBBBBBBBBBBBBBBBBBB",
    type: "CodeArtifact" as const,
    locator: "repo://repository_01K1BBBBBBBBBBBBBBBBBBBBBB/src/index.ts",
  };

  // Cross-checked independently with Python's uuid.uuid5 chain.
  it("pins a golden deterministic ID", () => {
    expect(scannedNodeId(identity)).toBe("code-artifact_ecf2ee1f-d355-591a-adc1-a08430845856");
  });

  it("is identical for logically equal locators across platform spellings", () => {
    const windows = scannedNodeId({
      ...identity,
      locator: "repo://repository_01K1BBBBBBBBBBBBBBBBBBBBBB/src\\index.ts",
    });
    const unicodeVariant = scannedNodeId({
      ...identity,
      locator: "repo://repository_01K1BBBBBBBBBBBBBBBBBBBBBB/src/Café.ts",
    });
    const unicodeComposed = scannedNodeId({
      ...identity,
      locator: "repo://repository_01K1BBBBBBBBBBBBBBBBBBBBBB/src/Caf\u00e9.ts",
    });
    expect(windows).toBe(scannedNodeId(identity));
    expect(unicodeVariant).toBe(unicodeComposed);
  });

  it("changes when repository, type, locator or project change", () => {
    const baseline = scannedNodeId(identity);
    expect(scannedNodeId({ ...identity, repository_id: "repository_02K1CCCC" })).not.toBe(baseline);
    expect(scannedNodeId({ ...identity, type: "Test" as const })).not.toBe(baseline);
    expect(
      scannedNodeId({
        ...identity,
        locator: "repo://repository_01K1BBBBBBBBBBBBBBBBBBBBBB/src/other.ts",
      }),
    ).not.toBe(baseline);
    expect(scannedNodeId({ ...identity, project_id: "project_02K1DDDD" })).not.toBe(baseline);
  });

  it("produces identifiers matching the protocol identifier pattern", () => {
    expect(scannedNodeId(identity)).toMatch(/^[a-z][a-z0-9-]*_[A-Za-z0-9_-]+$/);
  });
});

describe("human node ID", () => {
  it("uses a kebab-case type prefix and a Crockford ULID", () => {
    const id = humanNodeId("Intent", 1754982400000);
    expect(id).toMatch(/^intent_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  // ULID spec example: 1469918176385 ms encodes to 01ARYZ6S41.
  it("matches the ULID specification time encoding", () => {
    expect(ulid(1469918176385).slice(0, 10)).toBe("01ARYZ6S41");
  });

  it("never reuses identity across calls", () => {
    expect(humanNodeId("Intent")).not.toBe(humanNodeId("Intent"));
  });

  it("rejects out-of-range timestamps and unknown types", () => {
    expect(() => ulid(-1)).toThrow(/out of 48-bit range/);
    expect(() => ulid(2 ** 48)).toThrow(/out of 48-bit range/);
    expect(() => kebabNodeType("NotAType" as never)).toThrow(/Unknown node type/);
  });
});
