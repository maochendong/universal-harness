import { describe, expect, it } from "vitest";

import { actionFingerprint, RepeatDetector } from "../../src/loop/repeat-detector.js";
import type { RepeatObservation } from "../../src/loop/repeat-detector.js";

/**
 * Property tests over seeded pseudo-random traces. The workspace does not add
 * fast-check yet (no new third-party dependencies), so a deterministic
 * mulberry32 generator drives the cases; every seed reproduces exactly.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const index = Math.floor(random() * values.length);
  const value = values[index];
  if (value === undefined) throw new Error("unreachable: index out of range");
  return value;
}

/** Brute-force reference implementation of the detector contract. */
function bruteForce(
  history: readonly RepeatObservation[],
  window: number,
  limit: number,
): { repeated: boolean; occurrences: number } {
  const latest = history[history.length - 1];
  if (latest === undefined) return { repeated: false, occurrences: 0 };
  const occurrences = history
    .slice(-window)
    .filter(
      (candidate) =>
        candidate.fingerprint === latest.fingerprint &&
        candidate.state_digest === latest.state_digest &&
        candidate.evidence_digest === latest.evidence_digest,
    ).length;
  return { repeated: occurrences >= limit, occurrences };
}

describe("RepeatDetector properties", () => {
  it("matches a brute-force reference over random traces", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = mulberry32(seed);
      const window = 1 + Math.floor(random() * 8);
      const limit = 2 + Math.floor(random() * 3);
      const detector = new RepeatDetector({ window, identical_action_limit: limit });
      const fingerprints = ["f0", "f1", "f2"];
      const states = ["s0", "s1"];
      const evidences = ["e0", "e1"];
      const history: RepeatObservation[] = [];
      for (let step = 0; step < 40; step += 1) {
        const observation: RepeatObservation = {
          fingerprint: pick(random, fingerprints),
          state_digest: pick(random, states),
          evidence_digest: pick(random, evidences),
        };
        history.push(observation);
        const expected = bruteForce(history, window, limit);
        const actual = detector.observe(observation);
        expect(actual.occurrences).toBe(expected.occurrences);
        expect(actual.repeated).toBe(expected.repeated);
        expect(detector.size).toBe(Math.min(history.length, window));
      }
    }
  });

  it("never trips before the limit of stagnant occurrences and always trips at it", () => {
    for (let seed = 101; seed <= 150; seed += 1) {
      const random = mulberry32(seed);
      const limit = 2 + Math.floor(random() * 4);
      const detector = new RepeatDetector({ window: 50, identical_action_limit: limit });
      const fingerprint = pick(random, ["g0", "g1"]);
      let last = { repeated: false, occurrences: 0 };
      for (let count = 1; count <= limit; count += 1) {
        last = detector.observe({
          fingerprint,
          state_digest: "s",
          evidence_digest: "e",
        });
        if (count < limit) expect(last.repeated).toBe(false);
      }
      expect(last.repeated).toBe(true);
      expect(last.occurrences).toBe(limit);
    }
  });

  it("produces identical fingerprints for randomly key-shuffled parameters", () => {
    const base = { alpha: 1, beta: { x: [1, 2], y: "z" }, gamma: true, delta: null };
    const reference = actionFingerprint({ tool: "t@1.0.0", parameters: base });
    for (let seed = 201; seed <= 230; seed += 1) {
      const random = mulberry32(seed);
      const shuffledEntries = Object.entries(base)
        .map((entry) => ({ entry, order: random() }))
        .sort((left, right) => left.order - right.order)
        .map(({ entry }) => entry);
      const shuffled = Object.fromEntries(shuffledEntries);
      expect(actionFingerprint({ tool: "t@1.0.0", parameters: shuffled })).toBe(reference);
    }
  });

  it("produces distinct fingerprints for distinct calls", () => {
    const random = mulberry32(999);
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const fingerprint = actionFingerprint({
        tool: `tool_${String(index)}@1.0.0`,
        parameters: { value: Math.floor(random() * 1000000), index },
      });
      expect(seen.has(fingerprint)).toBe(false);
      seen.add(fingerprint);
    }
  });
});
