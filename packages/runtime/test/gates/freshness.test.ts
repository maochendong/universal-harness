import { describe, expect, it } from "vitest";

import {
  buildGateEvidence,
  type EvidenceBindings,
  type GateEvidenceRecord,
} from "../../src/gates/evidence.js";
import {
  evidenceFreshnessOf,
  evidenceStalenessReasons,
  findingClosableBy,
  isEvidenceStale,
  type CurrentEvidenceState,
} from "../../src/gates/freshness.js";
import type { GateOutcome } from "../../src/gates/provider.js";
import { BINDING_DIGESTS, FIXED_TIMESTAMP } from "./fixtures.js";

/**
 * Evidence freshness (design 15.3, completion rules 19-20): any changed,
 * added or removed bound input makes evidence stale; stale evidence can never
 * close a Finding or satisfy a completed Snapshot.
 */
const GATE_DIGEST = "0".repeat(64);

function boundBindings(): EvidenceBindings {
  return {
    artifact_digests: [BINDING_DIGESTS.artifact],
    code_digests: [BINDING_DIGESTS.code],
    context_bundle_digest: BINDING_DIGESTS.context,
    gate_digest: GATE_DIGEST,
    evaluation_case_digests: [BINDING_DIGESTS.evaluation],
    policy_digest: BINDING_DIGESTS.policy,
  };
}

function current(overrides?: Partial<CurrentEvidenceState>): CurrentEvidenceState {
  return { ...boundBindings(), ...overrides };
}

function evidence(options?: { passed?: boolean; provisional?: boolean }): GateEvidenceRecord {
  const outcome: GateOutcome = {
    gate_id: "gate_integrity",
    layer: "universal",
    mandatory: true,
    subject_id: "test_smoke",
    passed: options?.passed ?? true,
    exit_code: options?.passed === false ? 1 : 0,
    summary: "checks",
    log_summary: "",
    artifact_hashes: {},
    output_digest: "d".repeat(64),
  };
  return buildGateEvidence({
    evidenceId: "evidence_integrity",
    createdAt: FIXED_TIMESTAMP,
    ...(options?.provisional === true ? { provisional: true } : {}),
    outcome,
    bindings: boundBindings(),
  });
}

describe("evidence freshness", () => {
  it("is fresh while every bound digest holds", () => {
    const record = evidence();
    expect(evidenceStalenessReasons(record, current())).toEqual([]);
    expect(isEvidenceStale(record, current())).toBe(false);
    expect(evidenceFreshnessOf(record, current())).toBe("fresh");
  });

  it.each([
    ["artifact", { artifact_digests: ["7".repeat(64)] }],
    ["code", { code_digests: [] }],
    ["context bundle", { context_bundle_digest: "8".repeat(64) }],
    ["gate", { gate_digest: "9".repeat(64) }],
    ["evaluation case", { evaluation_case_digests: [] }],
    ["policy", { policy_digest: "6".repeat(64) }],
  ] as const)("goes stale when the bound %s input changes", (label, override) => {
    const record = evidence();
    const reasons = evidenceStalenessReasons(record, current(override));
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]).toContain(label);
  });

  it("goes stale when a covered artifact set gains a member", () => {
    const record = evidence();
    const drifted = current({
      artifact_digests: [BINDING_DIGESTS.artifact, "1".repeat(64)],
    });
    expect(isEvidenceStale(record, drifted)).toBe(true);
  });

  it("treats evidence without gate bindings as stale", () => {
    const record = { ...evidence(), extensions: {} };
    expect(isEvidenceStale(record, current())).toBe(true);
  });
});

describe("findingClosableBy", () => {
  it("closes only on a passed, non-provisional, fresh verdict", () => {
    expect(findingClosableBy(evidence(), current())).toBe(true);
  });

  it("never closes on stale evidence, however green it once was", () => {
    const drifted = current({ policy_digest: "6".repeat(64) });
    expect(findingClosableBy(evidence(), drifted)).toBe(false);
  });

  it("never closes on provisional or failed evidence", () => {
    expect(findingClosableBy(evidence({ provisional: true }), current())).toBe(false);
    expect(findingClosableBy(evidence({ passed: false }), current())).toBe(false);
  });
});
