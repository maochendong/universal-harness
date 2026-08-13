import { describe, expect, it } from "vitest";

import { contentDigest } from "@universal-harness-internal/core";

import { actionFingerprint, RepeatDetector } from "../../src/loop/repeat-detector.js";

const STATE_A = contentDigest({ state: "a" });
const STATE_B = contentDigest({ state: "b" });
const EVIDENCE_A = contentDigest({ evidence: ["a"] });
const EVIDENCE_B = contentDigest({ evidence: ["b"] });

describe("actionFingerprint", () => {
  it("is stable across parameter key order", () => {
    const left = actionFingerprint({
      tool: "apply_patch@1.0.0",
      parameters: { path: "src/a.ts", nested: { x: 1, y: [2, 3] }, flag: true },
      resource: "src/a.ts",
    });
    const right = actionFingerprint({
      tool: "apply_patch@1.0.0",
      parameters: { flag: true, nested: { y: [2, 3], x: 1 }, path: "src/a.ts" },
      resource: "src/a.ts",
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("differs when the tool, parameters or resource differ", () => {
    const base = actionFingerprint({ tool: "apply_patch@1.0.0", parameters: { path: "a" } });
    expect(actionFingerprint({ tool: "apply_patch@2.0.0", parameters: { path: "a" } })).not.toBe(
      base,
    );
    expect(actionFingerprint({ tool: "apply_patch@1.0.0", parameters: { path: "b" } })).not.toBe(
      base,
    );
    expect(
      actionFingerprint({ tool: "apply_patch@1.0.0", parameters: { path: "a" }, resource: "r" }),
    ).not.toBe(base);
  });
});

describe("RepeatDetector", () => {
  it("trips when the same call repeats without state or evidence progress", () => {
    const detector = new RepeatDetector({ window: 6, identical_action_limit: 2 });
    const fingerprint = actionFingerprint({ tool: "t@1.0.0", parameters: {} });
    const first = detector.observe({
      fingerprint,
      state_digest: STATE_A,
      evidence_digest: EVIDENCE_A,
    });
    expect(first.repeated).toBe(false);
    const second = detector.observe({
      fingerprint,
      state_digest: STATE_A,
      evidence_digest: EVIDENCE_A,
    });
    expect(second.repeated).toBe(true);
    expect(second.occurrences).toBe(2);
    expect(second.fingerprint).toBe(fingerprint);
  });

  it("does not trip when state or evidence progresses between identical calls", () => {
    const detector = new RepeatDetector({ window: 6, identical_action_limit: 2 });
    const fingerprint = actionFingerprint({ tool: "t@1.0.0", parameters: {} });
    detector.observe({ fingerprint, state_digest: STATE_A, evidence_digest: EVIDENCE_A });
    const progressed = detector.observe({
      fingerprint,
      state_digest: STATE_B,
      evidence_digest: EVIDENCE_A,
    });
    expect(progressed.repeated).toBe(false);
    const evidenceProgressed = detector.observe({
      fingerprint,
      state_digest: STATE_B,
      evidence_digest: EVIDENCE_B,
    });
    expect(evidenceProgressed.repeated).toBe(false);
  });

  it("counts only occurrences inside the sliding window", () => {
    const detector = new RepeatDetector({ window: 2, identical_action_limit: 2 });
    const a = actionFingerprint({ tool: "t@1.0.0", parameters: { id: 1 } });
    const b = actionFingerprint({ tool: "t@1.0.0", parameters: { id: 2 } });
    detector.observe({ fingerprint: a, state_digest: STATE_A, evidence_digest: EVIDENCE_A });
    detector.observe({ fingerprint: b, state_digest: STATE_A, evidence_digest: EVIDENCE_A });
    detector.observe({ fingerprint: b, state_digest: STATE_A, evidence_digest: EVIDENCE_A });
    // `a` fell out of the window, so its reappearance starts from zero.
    const again = detector.observe({
      fingerprint: a,
      state_digest: STATE_A,
      evidence_digest: EVIDENCE_A,
    });
    expect(again.repeated).toBe(false);
    expect(again.occurrences).toBe(1);
  });

  it("tracks distinct fingerprints independently", () => {
    const detector = new RepeatDetector({ window: 6, identical_action_limit: 3 });
    const a = actionFingerprint({ tool: "t@1.0.0", parameters: { id: 1 } });
    const b = actionFingerprint({ tool: "t@1.0.0", parameters: { id: 2 } });
    for (const fingerprint of [a, b, a, b]) {
      expect(
        detector.observe({ fingerprint, state_digest: STATE_A, evidence_digest: EVIDENCE_A })
          .repeated,
      ).toBe(false);
    }
    expect(
      detector.observe({ fingerprint: a, state_digest: STATE_A, evidence_digest: EVIDENCE_A })
        .repeated,
    ).toBe(true);
  });
});
