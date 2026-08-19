import { describe, expect, it } from "vitest";

import { canonicalSetDigest, canonicalStringSet } from "../../src/identity/canonical-set.js";
import { contentDigest } from "../../src/identity/digest.js";

describe("canonical string set", () => {
  const members = [
    "requirement_01K1BBBB",
    "capability:impact_analysis",
    "repo://repository_01/src/index.ts",
    "z",
    "a",
  ];

  it("produces the same canonical order regardless of input order", () => {
    const shuffled = [...members].reverse();
    expect(canonicalStringSet(members)).toEqual([...members].sort());
    expect(canonicalStringSet(shuffled)).toEqual(canonicalStringSet(members));
  });

  it("produces the same digest for any permutation of the same set", () => {
    const rotated = [...members.slice(2), ...members.slice(0, 2)];
    expect(canonicalSetDigest(rotated)).toBe(canonicalSetDigest(members));
    expect(canonicalSetDigest(members)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("deduplicates members and normalizes Unicode to NFC", () => {
    expect(canonicalStringSet(["b", "a", "b", "a"])).toEqual(["a", "b"]);
    const decomposed = canonicalStringSet(["Cafe\u0301"]);
    const composed = canonicalStringSet(["Caf\u00e9"]);
    expect(decomposed).toEqual(composed);
  });

  it("changes the digest on any semantic change to the set", () => {
    const baseline = canonicalSetDigest(members);
    expect(canonicalSetDigest([...members, "extra"])).not.toBe(baseline);
    expect(canonicalSetDigest(members.slice(1))).not.toBe(baseline);
    expect(canonicalSetDigest([...members.slice(0, -1), "A"])).not.toBe(baseline);
    expect(canonicalSetDigest(members)).toBe(contentDigest(canonicalStringSet(members)));
  });

  it("rejects non-string members", () => {
    expect(() => canonicalStringSet(["a", 1] as unknown as string[])).toThrow(
      /canonical set members must be strings/i,
    );
  });
});
