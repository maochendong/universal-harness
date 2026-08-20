import { describe, expect, it } from "vitest";

import {
  createDesignReviewRecord,
  createDesignSetProposalRecord,
  designSetContentDigest,
  verifyRecordEnvelope,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  type DesignSetContent,
} from "../../src/index.js";

/**
 * T12 design record factories: a record that cannot validate never exists.
 * Ids and digests derive deterministically from the semantic content, so a
 * resume re-creating the same proposal produces the same identity and never
 * duplicates a ledger fact.
 */
const digest = (letter: string) => letter.repeat(64);

function content(): DesignSetContent {
  return {
    requirement_baseline_digest: digest("b"),
    impact_set_id: "impactset_01K1IMP",
    impact_set_digest: digest("1"),
    policy_digest: digest("2"),
    repository_baseline: "deadbeef",
    mode: "change",
    node_changes: [],
    reused_assets: [],
    edge_changes: [],
    coverage: [],
    risk_summary: { level: "low", reasons: [] },
    rationale: "minimal",
  };
}

describe("createDesignSetProposalRecord", () => {
  it("mints a deterministic, registry-valid proposal record", () => {
    const record = createDesignSetProposalRecord({
      workflow_operation_id: "operation_01K1OP1",
      iteration_id: "iteration_01K1IT1",
      created_at: "2026-08-21T00:00:00.000Z",
      generator: { port: "in-memory-design-proposal" },
      content: content(),
    });
    expect(record.record_kind).toBe("design_set_proposal");
    expect(record.proposal_id.startsWith("design-set-proposal_")).toBe(true);
    expect(record.content_digest).toBe(designSetContentDigest(content()));
    expect(verifyRecordEnvelope(record)).toBe(true);
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-set-proposal", record).valid).toBe(true);

    const replay = createDesignSetProposalRecord({
      workflow_operation_id: "operation_01K1OP1",
      iteration_id: "iteration_01K1IT1",
      created_at: "2026-08-21T01:00:00.000Z",
      generator: { port: "other-port" },
      content: content(),
    });
    expect(replay.proposal_id).toBe(record.proposal_id);
    expect(replay.record_digest).not.toBe(record.record_digest);
  });
});

describe("createDesignReviewRecord", () => {
  it("mints a deterministic, registry-valid review record", () => {
    const record = createDesignReviewRecord({
      workflow_operation_id: "operation_01K1OP1",
      iteration_id: "iteration_01K1IT1",
      proposal_digest: digest("3"),
      proposal_content_digest: digest("c"),
      validation_digest: digest("4"),
      review_bundle_digest: digest("6"),
      reviewer_port: "in-memory-design-review",
      conversation_id: "conversation_01K1CV2",
      run_id: "run_01K1RN2",
      output: {
        verdict: "accept_recommended",
        findings: [],
        coverage_assessment: [{ requirement_id: "requirement_01K1REQ", status: "covered" }],
        residual_risks: [],
        summary: "clean",
      },
    });
    expect(record.record_kind).toBe("design_review");
    expect(record.review_id.startsWith("design-review_")).toBe(true);
    expect(verifyRecordEnvelope(record)).toBe(true);
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-review", record).valid).toBe(true);
  });
});
