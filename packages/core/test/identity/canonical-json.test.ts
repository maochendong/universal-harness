import { describe, expect, it } from "vitest";

import { CanonicalJsonError, canonicalizeJson } from "../../src/identity/canonical-json.js";
import { contentDigest } from "../../src/identity/digest.js";

describe("canonical JSON", () => {
  it("serializes objects with sorted keys regardless of insertion order", () => {
    const first = canonicalizeJson({ b: 1, a: "x", c: { z: true, y: null } });
    const second = canonicalizeJson({ c: { y: null, z: true }, a: "x", b: 1 });
    expect(first).toBe(second);
    expect(first).toBe('{"a":"x","b":1,"c":{"y":null,"z":true}}');
  });

  it("normalizes strings to NFC so composed and decomposed forms agree", () => {
    const composed = canonicalizeJson({ name: "Café" });
    const decomposed = canonicalizeJson({ name: "Café" });
    expect(composed).toBe(decomposed);
    expect(canonicalizeJson("é")).toBe(canonicalizeJson("é"));
  });

  it("preserves array order", () => {
    expect(canonicalizeJson([2, 1])).not.toBe(canonicalizeJson([1, 2]));
  });

  it("normalizes negative zero", () => {
    expect(canonicalizeJson(-0)).toBe("0");
    expect(canonicalizeJson({ value: -0 })).toBe(canonicalizeJson({ value: 0 }));
  });

  it("rejects non-JSON values", () => {
    expect(() => canonicalizeJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson({ fn: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson({ nested: { value: undefined } })).toThrow(CanonicalJsonError);
  });

  it("rejects keys that collide after Unicode normalization", () => {
    const record: Record<string, number> = { é: 1 };
    record["é"] = 2;
    expect(() => canonicalizeJson(record)).toThrow(CanonicalJsonError);
  });
});

describe("content digest", () => {
  // sha256 of {"a":"x","b":1}, computed independently with shasum(1).
  it("pins a golden digest computed independently of this codebase", () => {
    expect(contentDigest({ b: 1, a: "x" })).toBe(
      "cdab067e9f3beb32d1252cfd63e492592fecbf591b0d08cadb24bb17f3864246",
    );
  });

  it("is stable across key order and Unicode variants", () => {
    const baseline = contentDigest({ path: "src/Café.ts", lines: 12 });
    expect(contentDigest({ lines: 12, path: "src/Café.ts" })).toBe(baseline);
  });

  it("changes when any content changes", () => {
    const baseline = contentDigest({ path: "src/index.ts", lines: 12 });
    expect(contentDigest({ path: "src/index.ts", lines: 13 })).not.toBe(baseline);
  });
});
