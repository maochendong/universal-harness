import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

export interface LlmJudgeMandatoryResolution {
  readonly mandatory: boolean;
  readonly diagnostics: readonly string[];
  readonly policy_digest?: string;
  readonly approval_id?: string;
}

function currentNodes(nodes: readonly NodeRecord[]): Map<string, NodeRecord> {
  const current = new Map<string, NodeRecord>();
  for (const node of nodes) {
    const existing = current.get(node.id);
    if (existing === undefined || node.revision > existing.revision) current.set(node.id, node);
  }
  return current;
}

function approvalObjectDigest(node: NodeRecord): string | undefined {
  const extension = node.extensions?.["harness.approval"];
  if (typeof extension !== "object" || extension === null) return undefined;
  const digest = (extension as { object_digest?: unknown }).object_digest;
  return typeof digest === "string" ? digest : undefined;
}

/** Resolve requested mandatory into the only safe default: advisory unless policy is human-approved. */
export function resolveLlmJudgeMandatory(
  gateId: string,
  requestedMandatory: boolean,
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
): LlmJudgeMandatoryResolution {
  if (!requestedMandatory) return { mandatory: false, diagnostics: ["mandatory_not_requested"] };
  const current = currentNodes(nodes);
  const path = `gates.${gateId}.llm_judge_blocking`;
  const policies = [...current.values()]
    .filter(
      (node) =>
        node.type === "Policy" &&
        node.status === "accepted" &&
        node.policy_fields?.some((field) => field.path === path && field.value === true) === true,
    )
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const policy = policies.at(-1);
  if (policy === undefined) return { mandatory: false, diagnostics: ["blocking_policy_missing"] };
  const approvalEdges = edges
    .filter(
      (edge) =>
        edge.type === "APPROVES" && edge.status === "accepted" && edge.target_id === policy.id,
    )
    .sort((left, right) =>
      left.source_id < right.source_id ? -1 : left.source_id > right.source_id ? 1 : 0,
    );
  let sawApproval = false;
  for (const approvalEdge of approvalEdges) {
    const approval = current.get(approvalEdge.source_id);
    if (approval?.type !== "Approval" || approval.status !== "accepted") continue;
    sawApproval = true;
    if (approvalObjectDigest(approval) === policy.digest) {
      return {
        mandatory: true,
        diagnostics: [],
        policy_digest: policy.digest,
        approval_id: approval.id,
      };
    }
  }
  return {
    mandatory: false,
    diagnostics: [sawApproval ? "blocking_policy_approval_stale" : "blocking_policy_unapproved"],
  };
}
