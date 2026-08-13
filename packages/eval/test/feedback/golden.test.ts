import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
} from "@universal-harness-internal/runtime";

import { buildFindingRecord, closeFinding } from "../../src/feedback/finding.js";
import { buildImprovementCandidate } from "../../src/feedback/improvement.js";
import { promoteImprovementCandidate } from "../../src/feedback/promotion.js";
import { analyzeRootCause, readRootCauseContent } from "../../src/feedback/rca.js";
import { routeRevisionTask } from "../../src/feedback/router.js";

import { TIMESTAMP_CLOCK, currentState, findingSpec, gateEvidence, makeNode } from "./fixtures.js";

const goldenDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tests/golden/feedback",
);

function readGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as unknown;
}

/**
 * Golden feedback summaries (plan Task 21): fixed inputs, stable records.
 * The cascade golden pins the deterministic Finding -> RCA -> owner-phase
 * routing chain of a stack gate failure; the promotion golden pins the
 * reviewable ImprovementCandidate and its approved ledger revision.
 */
export function summarizeRepairCascade() {
  const finding = buildFindingRecord(findingSpec());
  const rca = analyzeRootCause({
    id: "rca_build",
    finding,
    signal: {
      origin: "test",
      gateLayer: "stack",
      module: "packages/runtime",
      evidenceIds: ["evidence_build"],
    },
    clock: TIMESTAMP_CLOCK,
  });
  const routing = routeRevisionTask({
    rca,
    targetNodeIds: ["constraint_build-green"],
    taskId: "task_revise-build-green",
    requiredGates: ["gate_build"],
  });
  const closed = closeFinding(finding, gateEvidence(), currentState());
  return {
    finding: { id: finding.id, status: finding.status, digest: finding.digest },
    rca: { id: rca.id, digest: rca.digest, content: readRootCauseContent(rca) },
    routing: {
      owner_phase: routing.owner_phase,
      responsible_layer: routing.responsible_layer,
      task: routing.task,
    },
    closure: { status: closed.status, digest: closed.digest },
  };
}

export function summarizePromotion() {
  const candidate = buildImprovementCandidate({
    id: "improvement_repeat-case",
    iterationId: "iteration_01",
    summary: "add a repeat-detection evaluation case",
    content: {
      target_kind: "evaluation",
      target_layer: "eval",
      failure_class: "repeat-tool-call",
      expected_behavior: "the run terminates with a typed repeat detection instead of looping",
      reproduction: ["run the repeat scenario with a stuck tool"],
      verification_method: "re-run the repeat evaluation case and require a correct_failure pass",
      source_rca_id: "rca_repeat",
      approved_secret_references: [],
    },
    clock: TIMESTAMP_CLOCK,
  });
  const request: ApprovalRequestRecord = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "approval_request",
    request_id: "approvalreq_promote-repeat",
    workflow_operation_id: "wfop_01",
    object_id: candidate.id,
    object_type: "ImprovementCandidate",
    object_digest: candidate.digest,
    baseline_digest: "0".repeat(64),
    policy_digest: "f".repeat(64),
    preview_digest: "1".repeat(64),
    impact_path: [],
    risk: "medium",
    reason: "promote the repeat-detection evaluation case",
    allowed_decisions: ["approve", "reject", "defer"],
    created_at: "2026-08-11T00:00:00.000Z",
    resume_phase: "verification",
    extensions: { "harness.approval": { proposed_by: "agent-1" } },
  };
  const decision: ApprovalDecisionRecord = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "approval_decision",
    approval_id: "approval_repeat",
    request_id: request.request_id,
    actor: "human-1",
    decision: "approve",
    object_digest: candidate.digest,
    decided_at: "2026-08-11T00:00:00.000Z",
  };
  const outcome = promoteImprovementCandidate({
    candidate,
    request,
    decision,
    target: makeNode("evaluationcase_repeat", "EvaluationCase"),
    actor: "workflow-engine",
    timestamp: "2026-08-11T00:00:00.000Z",
  });
  return {
    proposed: { id: candidate.id, status: candidate.status, digest: candidate.digest },
    promoted: { status: outcome.candidate.status, digest: outcome.candidate.digest },
    revision: {
      id: outcome.revision.id,
      revision: outcome.revision.revision,
      status: outcome.revision.status,
      digest: outcome.revision.digest,
    },
  };
}

describe("feedback goldens", () => {
  it("pins the repair cascade summary", () => {
    expect(summarizeRepairCascade()).toEqual(readGolden("repair-cascade.json"));
  });

  it("pins the improvement promotion summary", () => {
    expect(summarizePromotion()).toEqual(readGolden("improvement-promotion.json"));
  });
});
