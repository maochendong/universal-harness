import { describe, expect, it } from "vitest";

import { validateSchema } from "@universal-harness-internal/core";

import {
  FeedbackError,
  acceptFinding,
  buildFindingRecord,
  closeFinding,
  findingEdgeRecords,
  findingNodeRecord,
  readFindingSubject,
  supersedeFinding,
} from "../../src/feedback/finding.js";

import { currentState, findingSpec, gateEvidence } from "./fixtures.js";

const CONTEXT = { actor: "workflow-engine", timestamp: "2026-08-11T00:00:00.000Z" } as const;

/**
 * Finding records and lifecycle (design 9.1, plan Task 21, completion rule
 * 19): failures normalize into proposed Findings bound to what they violate
 * and block; only current repair evidence closes them -- stale, provisional
 * or failed evidence never does.
 */
describe("buildFindingRecord", () => {
  it("builds a schema-valid proposed Finding with a deterministic digest", () => {
    const finding = buildFindingRecord(findingSpec());
    expect(validateSchema("feedback", finding).valid).toBe(true);
    expect(finding.type).toBe("Finding");
    expect(finding.status).toBe("proposed");
    expect(buildFindingRecord(findingSpec()).digest).toBe(finding.digest);
  });

  it("normalizes subject bindings as sorted unique sets", () => {
    const finding = buildFindingRecord(
      findingSpec({
        subject: {
          origin: "test",
          blocking: true,
          violates: ["constraint_b", "constraint_a", "constraint_b"],
          blocks: ["task_b", "task_a"],
          evidence: ["evidence_build"],
        },
      }),
    );
    expect(readFindingSubject(finding).violates).toEqual(["constraint_a", "constraint_b"]);
    expect(readFindingSubject(finding).blocks).toEqual(["task_a", "task_b"]);
  });

  it("rejects an unknown failure origin", () => {
    expect(() =>
      buildFindingRecord(
        findingSpec({
          subject: {
            origin: "telemetry" as never,
            blocking: false,
            violates: [],
            blocks: [],
            evidence: [],
          },
        }),
      ),
    ).toThrowError(FeedbackError);
  });
});

describe("finding lifecycle", () => {
  it("transitions proposed -> accepted -> closed on current repair evidence", () => {
    const finding = acceptFinding(buildFindingRecord(findingSpec()));
    expect(finding.status).toBe("accepted");
    const closed = closeFinding(finding, gateEvidence(), currentState());
    expect(closed.status).toBe("closed");
    expect(validateSchema("feedback", closed).valid).toBe(true);
  });

  it("refuses to close with stale repair evidence", () => {
    const finding = buildFindingRecord(findingSpec());
    const drifted = currentState({ policy_digest: "6".repeat(64) });
    expect(() => closeFinding(finding, gateEvidence(), drifted)).toThrowError(
      expect.objectContaining({ kind: "stale_evidence" }) as Error,
    );
  });

  it("refuses to close with failed or provisional evidence", () => {
    const finding = buildFindingRecord(findingSpec());
    expect(() =>
      closeFinding(finding, gateEvidence({ passed: false }), currentState()),
    ).toThrowError(expect.objectContaining({ kind: "stale_evidence" }) as Error);
    expect(() =>
      closeFinding(finding, gateEvidence({ provisional: true }), currentState()),
    ).toThrowError(expect.objectContaining({ kind: "stale_evidence" }) as Error);
  });

  it("refuses illegal transitions", () => {
    const finding = buildFindingRecord(findingSpec());
    const closed = closeFinding(finding, gateEvidence(), currentState());
    expect(() => closeFinding(closed, gateEvidence(), currentState())).toThrowError(
      expect.objectContaining({ kind: "invalid_feedback_transition" }) as Error,
    );
    expect(supersedeFinding(finding).status).toBe("superseded");
    expect(() => acceptFinding(supersedeFinding(finding))).toThrowError(
      expect.objectContaining({ kind: "invalid_feedback_transition" }) as Error,
    );
  });
});

describe("finding graph projection", () => {
  it("projects a Finding node with VIOLATES and BLOCKS edges", () => {
    const finding = buildFindingRecord(findingSpec());
    const node = findingNodeRecord(finding, CONTEXT);
    expect(validateSchema("node", node).valid).toBe(true);
    expect(node.type).toBe("Finding");
    expect(node.source).toBe("gate");

    const edges = findingEdgeRecords(finding, CONTEXT);
    expect(edges.map((edge) => edge.type)).toEqual(["VIOLATES", "BLOCKS"]);
    expect(edges[0]?.target_id).toBe("constraint_build-green");
    expect(edges[1]?.target_id).toBe("task_implement-feature");
    for (const edge of edges) {
      expect(validateSchema("edge", edge).valid).toBe(true);
    }
  });

  it("keeps the feedback digest on the projected node", () => {
    const finding = buildFindingRecord(findingSpec());
    const node = findingNodeRecord(finding, CONTEXT);
    const extension = node.extensions?.["harness.finding"] as { feedback_digest: string };
    expect(extension.feedback_digest).toBe(finding.digest);
  });
});
