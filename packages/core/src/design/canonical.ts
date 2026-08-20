import { contentDigest } from "../identity/digest.js";
import type { DesignSetContent } from "../schema/design-set.js";

/**
 * Canonical DesignSet content (designset lifecycle design 7.5): every
 * collection sorted by its stable key and deduplicated, so the content
 * digest is order-insensitive and reproducible by any party — the proposal
 * validator, the review bundle and the eventual committer all compute the
 * same digest over the same semantics. Generator provenance, timestamps and
 * run identities never enter this digest.
 */
function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dedupe<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const marker = key(value);
    if (seen.has(marker)) continue;
    seen.add(marker);
    result.push(value);
  }
  return result;
}

export function canonicalizeDesignSetContent(content: DesignSetContent): DesignSetContent {
  return {
    ...content,
    node_changes: dedupe(
      [...content.node_changes].sort(
        (left, right) =>
          byId(left.node_id, right.node_id) || left.target_revision - right.target_revision,
      ),
      (change) => `${change.node_id}#${change.target_revision}`,
    ),
    reused_assets: dedupe(
      [...content.reused_assets].sort(
        (left, right) => byId(left.node_id, right.node_id) || left.revision - right.revision,
      ),
      (asset) => `${asset.node_id}#${asset.revision}`,
    ),
    edge_changes: dedupe(
      [...content.edge_changes].sort((left, right) => byId(left.edge_id, right.edge_id)),
      (edge) => edge.edge_id,
    ),
    coverage: [...content.coverage]
      .sort((left, right) => byId(left.requirement_id, right.requirement_id))
      .map((entry) => ({
        ...entry,
        test_strategy_coverage: dedupe(
          [...entry.test_strategy_coverage].sort(
            (left, right) =>
              byId(left.acceptance_criterion_id, right.acceptance_criterion_id) ||
              byId(left.test_node_id, right.test_node_id) ||
              byId(left.primary_test_strategy_id, right.primary_test_strategy_id),
          ),
          (binding) =>
            `${binding.acceptance_criterion_id}#${binding.test_node_id}#${binding.primary_test_strategy_id}`,
        ),
        supporting_test_strategy_ids: [...new Set(entry.supporting_test_strategy_ids)].sort(byId),
        decision_ids: [...new Set(entry.decision_ids)].sort(byId),
      })),
  };
}

export function designSetContentDigest(content: DesignSetContent): string {
  return contentDigest(canonicalizeDesignSetContent(content));
}
