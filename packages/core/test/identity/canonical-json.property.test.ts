import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../src/identity/canonical-json.js";
import { contentDigest } from "../../src/identity/digest.js";
import { mulberry32, pick, randomInt } from "./seeds.js";

const SEGMENTS = [
  "alpha",
  "beta",
  "src",
  "index.ts",
  " Café ",
  "日本語",
  "x",
  "0",
  "deeply/nested",
];

function randomJson(random: () => number, depth: number): unknown {
  const kind = randomInt(random, depth <= 0 ? 4 : 7);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return random() < 0.5;
    case 2:
      return randomInt(random, 1_000_000) - 500_000;
    case 3:
      return pick(random, SEGMENTS).repeat(randomInt(random, 3) + 1);
    case 4:
    case 5: {
      const length = randomInt(random, 5);
      return Array.from({ length }, () => randomJson(random, depth - 1));
    }
    default: {
      const size = randomInt(random, 5);
      const record: Record<string, unknown> = {};
      for (let index = 0; index < size; index += 1) {
        record[`${pick(random, SEGMENTS).trim()}_${index}`] = randomJson(random, depth - 1);
      }
      return record;
    }
  }
}

/** Rebuild objects with shuffled key insertion order, deeply. */
function reshuffle(value: unknown, random: () => number): unknown {
  if (Array.isArray(value)) return value.map((item) => reshuffle(item, random));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      reshuffle(item, random),
    ]);
    for (let index = entries.length - 1; index > 0; index -= 1) {
      const swap = randomInt(random, index + 1);
      const temp = entries[index];
      entries[index] = entries[swap] ?? temp;
      entries[swap] = temp ?? entries[index];
    }
    return Object.fromEntries(entries as Array<[string, unknown]>);
  }
  return value;
}

describe("canonical JSON properties", () => {
  it("key order never changes the canonical form or the digest", () => {
    const random = mulberry32(20260812);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const value = randomJson(random, 4);
      const canonical = canonicalizeJson(value);
      for (let round = 0; round < 3; round += 1) {
        const shuffled = reshuffle(value, random);
        expect(canonicalizeJson(shuffled)).toBe(canonical);
        expect(contentDigest(shuffled)).toBe(contentDigest(value));
      }
    }
  });

  it("serialization is idempotent", () => {
    const random = mulberry32(42);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const value = randomJson(random, 3);
      const canonical = canonicalizeJson(value);
      expect(canonicalizeJson(JSON.parse(canonical))).toBe(canonical);
    }
  });
});
