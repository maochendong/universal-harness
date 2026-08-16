import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

import { readFindingGovernance } from "./governance.js";

export interface FindingDecayInput {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
  /** Finding ids still reproduced by the deterministic predicate re-run. */
  readonly liveFindingIds: readonly string[];
}

export interface FindingDecayPlan {
  readonly finding: NodeRecord;
  readonly incidentEdges: readonly EdgeRecord[];
  readonly cause: "predicate_resolved";
  readonly oldSubjectDigests: readonly string[];
  readonly newSubjectDigests: readonly string[];
}

function currentNodes(nodes: readonly NodeRecord[]): NodeRecord[] {
  const current = new Map<string, NodeRecord>();
  for (const node of nodes) {
    const existing = current.get(node.id);
    if (existing === undefined || node.revision > existing.revision) current.set(node.id, node);
  }
  return [...current.values()].filter((node) => node.status !== "tombstoned");
}

function active(edge: EdgeRecord): boolean {
  return edge.status === "accepted" || edge.status === "proposed";
}

/**
 * Pure decay planner. The caller re-runs Audit predicates first and supplies
 * their live ids; only explicitly auto-close Findings may decay.
 */
export function planFindingDecay(input: FindingDecayInput): FindingDecayPlan[] {
  const nodes = currentNodes(input.nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const live = new Set(input.liveFindingIds);
  return nodes
    .filter(
      (node) =>
        node.type === "Finding" &&
        (node.status === "proposed" || node.status === "accepted") &&
        !live.has(node.id) &&
        readFindingGovernance(node).actionability === "auto_close",
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((finding) => {
      const governance = readFindingGovernance(finding);
      return {
        finding,
        incidentEdges: input.edges
          .filter(
            (edge) =>
              active(edge) && (edge.source_id === finding.id || edge.target_id === finding.id),
          )
          .sort((left, right) => left.id.localeCompare(right.id)),
        cause: "predicate_resolved" as const,
        oldSubjectDigests: [...governance.subject_digests],
        newSubjectDigests: governance.subject_ids
          .map((id) => nodeById.get(id)?.digest)
          .filter((digest): digest is string => digest !== undefined)
          .sort(),
      };
    });
}
