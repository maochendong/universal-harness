import { sha256Hex, type NodeRecord } from "@universal-harness-internal/core";

import {
  readFindingGovernance,
  type FindingActionability,
  type FindingGovernanceMetadata,
  type FindingSeverity,
} from "./governance.js";

export interface FindingGroupProjection {
  readonly group_id: string;
  readonly rule: string;
  readonly scope_prefix: string;
  readonly severity: FindingSeverity;
  readonly actionability: FindingActionability;
  readonly open_count: number;
  readonly accepted_count: number;
  readonly member_count: number;
  readonly membership_digest: string;
  readonly samples: readonly string[];
  readonly first_seen: string;
  readonly last_seen: string;
}

interface FindingGroupMember {
  readonly node: NodeRecord;
  readonly governance: FindingGovernanceMetadata;
}

function groupKey(governance: FindingGovernanceMetadata): string {
  return `${governance.rule}${governance.scope_prefix}${governance.severity}${governance.actionability}`;
}

function currentFindings(nodes: readonly NodeRecord[]): NodeRecord[] {
  const current = new Map<string, NodeRecord>();
  for (const node of nodes) {
    if (node.type !== "Finding") continue;
    const existing = current.get(node.id);
    if (existing === undefined || node.revision > existing.revision) current.set(node.id, node);
  }
  return [...current.values()].filter((node) => node.status !== "tombstoned");
}

function membershipDigest(members: readonly FindingGroupMember[]): string {
  return sha256Hex(
    members
      .map(({ node }) => `${node.id}${String(node.revision)}${node.status}${node.digest}`)
      .sort()
      .join(""),
  );
}

/** Pure, stable projection of current Finding revisions into governance groups. */
export function projectFindingGroups(nodes: readonly NodeRecord[]): FindingGroupProjection[] {
  const groups = new Map<string, FindingGroupMember[]>();
  for (const node of currentFindings(nodes)) {
    const governance = readFindingGovernance(node);
    const key = groupKey(governance);
    groups.set(key, [...(groups.get(key) ?? []), { node, governance }]);
  }
  return [...groups.entries()]
    .map(([key, unsortedMembers]) => {
      const members = [...unsortedMembers].sort((left, right) =>
        left.node.id.localeCompare(right.node.id),
      );
      const governance = members[0]?.governance as FindingGovernanceMetadata;
      const timestamps = members.map(({ node }) => node.provenance.timestamp).sort();
      return {
        group_id: `finding-group_${sha256Hex(key).slice(0, 16)}`,
        rule: governance.rule,
        scope_prefix: governance.scope_prefix,
        severity: governance.severity,
        actionability: governance.actionability,
        open_count: members.filter(
          ({ node }) => node.status === "proposed" || node.status === "accepted",
        ).length,
        accepted_count: members.filter(({ node }) => node.status === "accepted").length,
        member_count: members.length,
        membership_digest: membershipDigest(members),
        samples: members.slice(0, 5).map(({ node }) => node.id),
        first_seen: timestamps[0] as string,
        last_seen: timestamps.at(-1) as string,
      } satisfies FindingGroupProjection;
    })
    .sort((left, right) => left.group_id.localeCompare(right.group_id));
}
