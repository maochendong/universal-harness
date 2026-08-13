import { PROTOCOL_VERSION, contentDigest, type NodeRecord } from "@universal-harness-internal/core";
import {
  buildGateEvidence,
  type CurrentEvidenceState,
  type EvidenceBindings,
  type GateEvidenceRecord,
  type GateOutcome,
} from "@universal-harness-internal/runtime";

import type { FindingSpec } from "../../src/feedback/finding.js";

/** Shared builders for deterministic feedback tests (plan Task 21). */

export const FIXED_TIMESTAMP = "2026-08-11T00:00:00.000Z";
export const TIMESTAMP_CLOCK = (): string => FIXED_TIMESTAMP;

export const BINDING_DIGESTS = {
  artifact: "a".repeat(64),
  code: "b".repeat(64),
  context: "c".repeat(64),
  gate: "0".repeat(64),
  evaluation: "e".repeat(64),
  policy: "f".repeat(64),
} as const;

export function boundBindings(): EvidenceBindings {
  return {
    artifact_digests: [BINDING_DIGESTS.artifact],
    code_digests: [BINDING_DIGESTS.code],
    context_bundle_digest: BINDING_DIGESTS.context,
    gate_digest: BINDING_DIGESTS.gate,
    evaluation_case_digests: [BINDING_DIGESTS.evaluation],
    policy_digest: BINDING_DIGESTS.policy,
  };
}

export function currentState(overrides?: Partial<CurrentEvidenceState>): CurrentEvidenceState {
  return { ...boundBindings(), ...overrides };
}

export function gateEvidence(options?: {
  passed?: boolean;
  provisional?: boolean;
  evidenceId?: string;
}): GateEvidenceRecord {
  const passed = options?.passed ?? true;
  const outcome: GateOutcome = {
    gate_id: "gate_build",
    layer: "stack",
    mandatory: true,
    subject_id: "test_smoke",
    passed,
    exit_code: passed ? 0 : 1,
    summary: passed ? "all checks passed" : "2 tests failed",
    log_summary: "",
    artifact_hashes: {},
    output_digest: "d".repeat(64),
  };
  return buildGateEvidence({
    evidenceId: options?.evidenceId ?? "evidence_build",
    createdAt: FIXED_TIMESTAMP,
    ...(options?.provisional === true ? { provisional: true } : {}),
    outcome,
    bindings: boundBindings(),
  });
}

export function findingSpec(overrides?: Partial<FindingSpec>): FindingSpec {
  return {
    id: "finding_build",
    iterationId: "iteration_01",
    summary: "Mandatory stack gate gate_build failed: 2 tests failed",
    subject: {
      origin: "test",
      blocking: true,
      violates: ["constraint_build-green"],
      blocks: ["task_implement-feature"],
      evidence: ["evidence_build"],
    },
    clock: TIMESTAMP_CLOCK,
    ...overrides,
  };
}

export function makeNode(id: string, type: NodeRecord["type"]): NodeRecord {
  const content = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id,
    type,
    revision: 1,
    status: "accepted",
    source: "human",
    provenance: {
      iteration_id: "iteration_01",
      actor: "human-1",
      timestamp: FIXED_TIMESTAMP,
    },
    confidence: 1,
  };
  return { ...content, digest: contentDigest(content) } as unknown as NodeRecord;
}
