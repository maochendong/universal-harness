import { describe, expect, it } from "vitest";

import { validateSchema } from "@universal-harness-internal/core";

import {
  buildGateEvidence,
  evidenceBindingsOf,
  readGateEvidenceExtension,
  type EvidenceBindings,
} from "../../src/gates/evidence.js";
import type { GateOutcome } from "../../src/gates/provider.js";
import { BINDING_DIGESTS, FIXED_TIMESTAMP } from "./fixtures.js";

/**
 * Gate evidence records (design 15.3, plan Task 19): every verdict is an
 * append-only Evidence record binding the applicable artifact, code,
 * ContextBundle, gate, EvaluationCase and Policy digests.
 */
function outcome(overrides?: Partial<GateOutcome>): GateOutcome {
  return {
    gate_id: "gate_integrity",
    layer: "universal",
    mandatory: true,
    subject_id: "test_smoke",
    passed: true,
    exit_code: 0,
    summary: "all checks passed",
    log_summary: "12 checks, 0 failures",
    artifact_hashes: { "dist/report.json": "a".repeat(64) },
    output_digest: "d".repeat(64),
    ...overrides,
  };
}

export function bindings(overrides?: Partial<EvidenceBindings>): EvidenceBindings {
  return {
    artifact_digests: [BINDING_DIGESTS.artifact],
    code_digests: [BINDING_DIGESTS.code],
    context_bundle_digest: BINDING_DIGESTS.context,
    gate_digest: "0".repeat(64),
    evaluation_case_digests: [BINDING_DIGESTS.evaluation],
    policy_digest: BINDING_DIGESTS.policy,
    ...overrides,
  };
}

function build(overrides?: {
  outcome?: Partial<GateOutcome>;
  bindings?: Partial<EvidenceBindings>;
  provisional?: boolean;
}) {
  return buildGateEvidence({
    evidenceId: "evidence_integrity",
    createdAt: FIXED_TIMESTAMP,
    ...(overrides?.provisional === true ? { provisional: true } : {}),
    outcome: outcome(overrides?.outcome),
    bindings: bindings(overrides?.bindings),
  });
}

describe("buildGateEvidence", () => {
  it("produces a schema-valid evidence record with source-compatible fields", () => {
    const record = build();
    expect(validateSchema("runtime", record).valid).toBe(true);
    expect(record.record_kind).toBe("evidence");
    expect(record.evidence_type).toBe("gate_result");
    expect(record.subject_id).toBe("test_smoke");
    expect(record.provisional).toBe(false);
  });

  it("binds artifact, code, context bundle, gate, evaluation case and policy digests", () => {
    const bound = evidenceBindingsOf(build());
    expect(bound).toEqual({
      artifact_digests: [BINDING_DIGESTS.artifact],
      code_digests: [BINDING_DIGESTS.code],
      context_bundle_digest: BINDING_DIGESTS.context,
      gate_digest: "0".repeat(64),
      evaluation_case_digests: [BINDING_DIGESTS.evaluation],
      policy_digest: BINDING_DIGESTS.policy,
    });
  });

  it("stores the normalized outcome in the gate extension", () => {
    const extension = readGateEvidenceExtension(build());
    expect(extension?.gate_id).toBe("gate_integrity");
    expect(extension?.passed).toBe(true);
    expect(extension?.exit_code).toBe(0);
    expect(extension?.artifact_hashes).toEqual({ "dist/report.json": "a".repeat(64) });
  });

  it("digests the verdict plus bindings, not the minted id or timestamp", () => {
    const first = build();
    const same = build();
    expect(same.digest).toBe(first.digest);
    const differentOutcome = build({ outcome: { passed: false, exit_code: 1 } });
    expect(differentOutcome.digest).not.toBe(first.digest);
    const differentBindings = build({ bindings: { policy_digest: "9".repeat(64) } });
    expect(differentBindings.digest).not.toBe(first.digest);
  });

  it("marks provisional evidence explicitly", () => {
    expect(build({ provisional: true }).provisional).toBe(true);
  });
});
