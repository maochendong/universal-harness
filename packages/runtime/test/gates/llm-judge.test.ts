import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  contentDigest,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";

import { resolveLlmJudgeMandatory } from "../../src/index.js";

function node(
  id: string,
  type: NodeRecord["type"],
  options: {
    readonly policyFields?: NodeRecord["policy_fields"];
    readonly extensions?: Record<string, unknown>;
  } = {},
): NodeRecord {
  const content = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node" as const,
    id,
    type,
    revision: 1,
    status: "accepted" as const,
    source: "human" as const,
    provenance: {
      iteration_id: "iteration_01",
      actor: "human:policy",
      timestamp: "2026-08-16T00:00:00.000Z",
    },
    confidence: 1,
    ...(options.policyFields === undefined ? {} : { policy_fields: options.policyFields }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
  };
  return { ...content, digest: contentDigest(content) } as NodeRecord;
}

function edge(sourceId: string, targetId: string): EdgeRecord {
  const content = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge" as const,
    id: "edge_judge_policy_approval",
    type: "APPROVES" as const,
    source_id: sourceId,
    target_id: targetId,
    status: "accepted" as const,
    source: "human" as const,
    provenance: {
      iteration_id: "iteration_01",
      actor: "human:policy",
      timestamp: "2026-08-16T00:00:00.000Z",
    },
    confidence: 1,
  };
  return { ...content, digest: contentDigest(content) } as EdgeRecord;
}

describe("LLM judge effective mandatory policy", () => {
  it("defaults to advisory without a requested and approved fresh opt-in", () => {
    expect(resolveLlmJudgeMandatory("gate_review", true, [], [])).toEqual({
      mandatory: false,
      diagnostics: ["blocking_policy_missing"],
    });
    expect(resolveLlmJudgeMandatory("gate_review", false, [], [])).toEqual({
      mandatory: false,
      diagnostics: ["mandatory_not_requested"],
    });
  });

  it("requires an accepted Policy plus an Approval bound to that exact revision digest", () => {
    const policy = node("policy_review", "Policy", {
      policyFields: [
        {
          path: "gates.gate_review.llm_judge_blocking",
          merge_operator: "project_default",
          value: true,
        },
      ],
    });
    const staleApproval = node("approval_review", "Approval", {
      extensions: { "harness.approval": { object_digest: "0".repeat(64) } },
    });
    expect(
      resolveLlmJudgeMandatory(
        "gate_review",
        true,
        [policy, staleApproval],
        [edge(staleApproval.id, policy.id)],
      ),
    ).toEqual({ mandatory: false, diagnostics: ["blocking_policy_approval_stale"] });

    const approval = node("approval_review", "Approval", {
      extensions: { "harness.approval": { object_digest: policy.digest } },
    });
    expect(
      resolveLlmJudgeMandatory(
        "gate_review",
        true,
        [policy, approval],
        [edge(approval.id, policy.id)],
      ),
    ).toEqual({
      mandatory: true,
      diagnostics: [],
      policy_digest: policy.digest,
      approval_id: approval.id,
    });
  });
});
