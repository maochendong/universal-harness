import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  canonicalizeDesignSetContent,
  designSetContentDigest,
  type DesignSetContent,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";

export { canonicalizeDesignSetContent, designSetContentDigest };

import { isRelationCompatible } from "../integrity.js";

/**
 * Deterministic DesignSet proposal validation (designset lifecycle design 9
 * and 10, plan T11). The validator is a pure module: no model calls, no
 * side effects, no silent repair. It checks an untrusted proposal against
 * committed graph facts in the fixed pipeline order of design section 10 —
 * shape, imperative content, reference, revision, relation, coverage,
 * conflict, risk, canonicalization, round-trip — and reports every failure
 * as a stable typed issue. Coverage can only be satisfied by this set's own
 * changes/reused assets and by accepted graph edges; proposed or inferred
 * edges never count (design 9.2 rule 7).
 */
export const DESIGN_SET_VALIDATION_ISSUE_CODES = [
  "shape_violation",
  "imperative_content",
  "stale_binding",
  "unknown_base_asset",
  "base_digest_drift",
  "revision_skew",
  "unknown_edge_endpoint",
  "relation_rule_violation",
  "missing_coverage",
  "unknown_requirement",
  "decision_coverage_gap",
  "component_scope_gap",
  "test_strategy_gap",
  "duplicate_criterion_coverage",
  "primary_strategy_tdd_invalid",
  "applicability_gap",
  "duplicate_asset",
  "duplicate_edge_id",
  "reuse_mode_violation",
  "risk_understated",
] as const;
export type DesignSetValidationIssueCode = (typeof DESIGN_SET_VALIDATION_ISSUE_CODES)[number];

export interface DesignSetValidationIssue {
  readonly code: DesignSetValidationIssueCode;
  readonly message: string;
  readonly target_id?: string;
  readonly path?: string;
}

export interface DesignSetBindings {
  readonly requirement_baseline_digest: string;
  readonly impact_set_id: string;
  readonly impact_set_digest: string;
  readonly policy_digest: string;
  readonly repository_baseline: string;
}

export interface CriterionTestPair {
  readonly requirement_id: string;
  readonly acceptance_criterion_id: string;
  readonly test_node_id: string;
}

export interface DesignSetValidationInput {
  /** The untrusted proposal content; shape is the first thing checked. */
  readonly content: unknown;
  readonly bindings: DesignSetBindings;
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
  readonly must_change_requirement_ids: readonly string[];
  /** Deterministic impact risk per must-change requirement. */
  readonly requirement_impact_risks: Readonly<Record<string, "low" | "medium" | "high">>;
  /** Accepted PRD (Acceptance Criterion, Test seed) pairs per requirement. */
  readonly criterion_test_pairs: readonly CriterionTestPair[];
}

/** Keys that would smuggle execution intent into a design proposal. */
export const FORBIDDEN_DESIGN_KEYS = [
  "command",
  "commands",
  "shell",
  "shell_command",
  "raw_shell",
  "script",
  "tool_invocation",
  "tool_invocations",
] as const;

const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

/**
 * Computed risk floor (design 10 step 8): the upper bound of the impact
 * risks of every covered requirement and of the change actions — any
 * create/revise is at least medium, and changing an api/data contract is
 * high because SPECIFIES binds it to its subjects at high risk. `critical`
 * is only ever declared by a human-facing summary, never computed here.
 */
const CONTRACT_KIND_FLOOR: Readonly<Record<string, number>> = {
  api_contract: RISK_RANK.high,
  data_contract: RISK_RANK.high,
};

function issue(
  code: DesignSetValidationIssueCode,
  message: string,
  extra: { readonly target_id?: string; readonly path?: string } = {},
): DesignSetValidationIssue {
  return {
    code,
    message,
    ...(extra.target_id === undefined ? {} : { target_id: extra.target_id }),
    ...(extra.path === undefined ? {} : { path: extra.path }),
  };
}

function containsForbiddenKeys(value: unknown, path: string): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = containsForbiddenKeys(value[index], `${path}/${index}`);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const childPath = `${path}/${key}`;
      if ((FORBIDDEN_DESIGN_KEYS as readonly string[]).includes(key)) return childPath;
      const hit = containsForbiddenKeys(entry, childPath);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

interface AssetRef {
  readonly nodeType: NodeRecord["type"];
  readonly extensions: Readonly<Record<string, unknown>> | undefined;
}

interface AssetIndex {
  /** Every id the proposal may reference: set members plus accepted graph nodes. */
  readonly types: ReadonlyMap<string, NodeRecord["type"]>;
  /** Latest accepted graph node per id. */
  readonly accepted: ReadonlyMap<string, NodeRecord>;
  /** Members of this DesignSet (node changes and reused assets). */
  readonly members: ReadonlyMap<string, AssetRef>;
  readonly memberSources: ReadonlyMap<string, "change" | "reuse">;
}

function buildAssetIndex(content: DesignSetContent, nodes: readonly NodeRecord[]): AssetIndex {
  const accepted = new Map<string, NodeRecord>();
  for (const node of nodes) {
    if (node.status !== "accepted") continue;
    const existing = accepted.get(node.id);
    if (existing === undefined || node.revision > existing.revision) accepted.set(node.id, node);
  }
  const types = new Map<string, NodeRecord["type"]>();
  for (const [id, node] of accepted) types.set(id, node.type);
  const members = new Map<string, AssetRef>();
  const memberSources = new Map<string, "change" | "reuse">();
  for (const change of content.node_changes) {
    types.set(change.node_id, change.node_type);
    members.set(change.node_id, {
      nodeType: change.node_type,
      extensions: change.proposed_extensions,
    });
    memberSources.set(change.node_id, "change");
  }
  for (const asset of content.reused_assets) {
    types.set(asset.node_id, asset.node_type);
    members.set(asset.node_id, {
      nodeType: asset.node_type,
      extensions: accepted.get(asset.node_id)?.extensions,
    });
    memberSources.set(asset.node_id, "reuse");
  }
  return { types, accepted, members, memberSources };
}

interface ArtifactContent {
  readonly artifact_kind: string;
  readonly body: unknown;
}

/** Read and shape-check the harness.design.artifact extension of an asset. */
function artifactContentOf(asset: AssetRef | undefined): ArtifactContent | undefined {
  const extension = asset?.extensions?.["harness.design.artifact"];
  if (extension === undefined) return undefined;
  const result = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-artifact-content", extension);
  if (!result.valid) return undefined;
  return extension as unknown as ArtifactContent;
}

export function validateDesignSetProposal(
  input: DesignSetValidationInput,
): DesignSetValidationIssue[] {
  const issues: DesignSetValidationIssue[] = [];

  // 1. Shape.
  const shape = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-set-content", input.content);
  if (!shape.valid) {
    return shape.errors.map((error) =>
      issue("shape_violation", error.message ?? "schema violation", {
        path: error.instancePath,
      }),
    );
  }
  const content = input.content as DesignSetContent;

  // 2. Imperative content.
  const forbidden = containsForbiddenKeys(content, "");
  if (forbidden !== undefined) {
    issues.push(
      issue("imperative_content", `forbidden execution key at ${forbidden}`, { path: forbidden }),
    );
  }

  // 3/4. Bindings, references and revisions.
  const bindings = input.bindings;
  const bindingChecks: Array<[keyof DesignSetBindings, string]> = [
    ["requirement_baseline_digest", content.requirement_baseline_digest],
    ["impact_set_id", content.impact_set_id],
    ["impact_set_digest", content.impact_set_digest],
    ["policy_digest", content.policy_digest],
    ["repository_baseline", content.repository_baseline],
  ];
  for (const [field, declared] of bindingChecks) {
    if (declared !== bindings[field]) {
      issues.push(
        issue(
          "stale_binding",
          `declared ${field} ${declared} does not match the current binding ${bindings[field]}`,
        ),
      );
    }
  }

  const index = buildAssetIndex(content, input.nodes);
  for (const change of content.node_changes) {
    const base = index.accepted.get(change.node_id);
    if (change.action === "create") {
      if (change.target_revision !== 1 || base !== undefined) {
        issues.push(
          issue(
            "revision_skew",
            `create of ${change.node_id} targets revision ${change.target_revision}; new nodes start at 1`,
            { target_id: change.node_id },
          ),
        );
      }
      continue;
    }
    if (base === undefined) {
      issues.push(
        issue("unknown_base_asset", `revise targets unknown accepted node ${change.node_id}`, {
          target_id: change.node_id,
        }),
      );
      continue;
    }
    if (
      change.base === undefined ||
      change.base.revision !== base.revision ||
      change.base.digest !== base.digest
    ) {
      issues.push(
        issue(
          "base_digest_drift",
          `revise of ${change.node_id} does not pin the current base revision/digest`,
          { target_id: change.node_id },
        ),
      );
      continue;
    }
    if (change.target_revision !== base.revision + 1) {
      issues.push(
        issue(
          "revision_skew",
          `revise of ${change.node_id} jumps to revision ${change.target_revision}, expected ${base.revision + 1}`,
          { target_id: change.node_id },
        ),
      );
    }
  }
  for (const asset of content.reused_assets) {
    const base = index.accepted.get(asset.node_id);
    if (base === undefined) {
      issues.push(
        issue("unknown_base_asset", `reuse references unknown accepted node ${asset.node_id}`, {
          target_id: asset.node_id,
        }),
      );
    } else if (base.digest !== asset.digest || base.revision !== asset.revision) {
      issues.push(
        issue(
          "base_digest_drift",
          `reused asset ${asset.node_id} drifted from the accepted revision/digest`,
          { target_id: asset.node_id },
        ),
      );
    }
  }

  // 5. Relation compatibility and endpoints.
  const acceptedEdges = input.edges.filter((edge) => edge.status === "accepted");
  const edgeById = new Map(input.edges.map((edge) => [edge.id, edge]));
  for (const edge of content.edge_changes) {
    const sourceType = index.types.get(edge.source_id);
    const targetType = index.types.get(edge.target_id);
    if (sourceType === undefined || targetType === undefined) {
      issues.push(
        issue("unknown_edge_endpoint", `edge ${edge.edge_id} references an unknown endpoint`, {
          target_id: edge.edge_id,
        }),
      );
      continue;
    }
    if (!isRelationCompatible(edge.relation, sourceType, targetType)) {
      issues.push(
        issue(
          "relation_rule_violation",
          `edge ${edge.edge_id} proposes ${edge.relation}: ${sourceType} -> ${targetType}, rejected by the relation registry`,
          { target_id: edge.edge_id },
        ),
      );
    }
    if (edge.action === "supersede") {
      const existing = edgeById.get(edge.edge_id);
      if (existing === undefined || existing.digest !== edge.base_digest) {
        issues.push(
          issue(
            "base_digest_drift",
            `supersede of edge ${edge.edge_id} does not pin the current edge digest`,
            { target_id: edge.edge_id },
          ),
        );
      }
    }
  }

  const semanticEdges = [
    ...acceptedEdges.map((edge) => ({
      relation: edge.type,
      source_id: edge.source_id,
      target_id: edge.target_id,
    })),
    ...content.edge_changes
      .filter((edge) => edge.action === "create")
      .map((edge) => ({
        relation: edge.relation as string,
        source_id: edge.source_id,
        target_id: edge.target_id,
      })),
  ];
  const hasEdge = (relation: string, sourceId: string, targetIds: ReadonlySet<string>): boolean =>
    semanticEdges.some(
      (edge) =>
        edge.relation === relation && edge.source_id === sourceId && targetIds.has(edge.target_id),
    );

  // 6. Coverage (design 9.2).
  const mustChange = new Set(input.must_change_requirement_ids);
  const coverageByRequirement = new Map(
    content.coverage.map((entry) => [entry.requirement_id, entry]),
  );
  for (const requirementId of mustChange) {
    if (!coverageByRequirement.has(requirementId)) {
      issues.push(
        issue(
          "missing_coverage",
          `must-change requirement ${requirementId} has no coverage entry`,
          {
            target_id: requirementId,
          },
        ),
      );
    }
  }
  for (const entry of content.coverage) {
    if (!mustChange.has(entry.requirement_id)) {
      issues.push(
        issue(
          "unknown_requirement",
          `coverage entry ${entry.requirement_id} is not a must-change requirement of the frozen impact set`,
          { target_id: entry.requirement_id },
        ),
      );
      continue;
    }

    // Rule 1: at least one Decision of this set ADDRESSES the requirement.
    const decisions = entry.decision_ids.filter(
      (id) => index.members.get(id)?.nodeType === "Decision",
    );
    if (
      decisions.length === 0 ||
      !decisions.some((id) => hasEdge("ADDRESSES", id, new Set([entry.requirement_id])))
    ) {
      issues.push(
        issue(
          "decision_coverage_gap",
          `requirement ${entry.requirement_id} lacks a set Decision linked by ADDRESSES`,
          { target_id: entry.requirement_id },
        ),
      );
    }

    // Rule 2: every Decision SHAPES a Component unless scope is not_applicable.
    const components = new Set(
      entry.component_scope.status === "not_applicable" ? [] : entry.component_scope.component_ids,
    );
    for (const id of components) {
      if (index.members.get(id)?.nodeType !== "Component") {
        issues.push(
          issue(
            "component_scope_gap",
            `component ${id} is not a Component member of this design set`,
            { target_id: id },
          ),
        );
      }
    }
    if (entry.component_scope.status !== "not_applicable") {
      for (const decisionId of decisions) {
        if (!hasEdge("SHAPES", decisionId, components)) {
          issues.push(
            issue(
              "component_scope_gap",
              `decision ${decisionId} does not SHAPE any scoped component`,
              { target_id: decisionId },
            ),
          );
        }
      }
    }

    // Rule 3: criterion pairs exactly once, primary strategy TDD-valid.
    const pairs = input.criterion_test_pairs.filter(
      (pair) => pair.requirement_id === entry.requirement_id,
    );
    const seenPairs = new Map<string, number>();
    for (const binding of entry.test_strategy_coverage) {
      const key = `${binding.acceptance_criterion_id}#${binding.test_node_id}`;
      seenPairs.set(key, (seenPairs.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seenPairs) {
      if (count > 1) {
        issues.push(
          issue(
            "duplicate_criterion_coverage",
            `criterion pair ${key} is covered ${count} times for ${entry.requirement_id}`,
            { target_id: entry.requirement_id },
          ),
        );
      }
    }
    for (const pair of pairs) {
      const key = `${pair.acceptance_criterion_id}#${pair.test_node_id}`;
      if (!seenPairs.has(key)) {
        issues.push(
          issue(
            "test_strategy_gap",
            `accepted criterion pair ${key} has no primary test strategy coverage`,
            { target_id: entry.requirement_id },
          ),
        );
      }
    }
    const pairKeys = new Set(
      pairs.map((pair) => `${pair.acceptance_criterion_id}#${pair.test_node_id}`),
    );
    for (const key of seenPairs.keys()) {
      if (!pairKeys.has(key)) {
        issues.push(
          issue("test_strategy_gap", `coverage binds unknown criterion pair ${key}`, {
            target_id: entry.requirement_id,
          }),
        );
      }
    }

    const strategyValid = (strategyId: string): boolean => {
      if (index.members.get(strategyId)?.nodeType !== "DesignArtifact") return false;
      const artifact = artifactContentOf(index.members.get(strategyId));
      if (artifact === undefined || artifact.artifact_kind !== "test_strategy") return false;
      const tdd = (artifact.body as { tdd?: Array<{ requirement_id: string }> }).tdd ?? [];
      return tdd.some((tddEntry) => tddEntry.requirement_id === entry.requirement_id);
    };
    for (const binding of entry.test_strategy_coverage) {
      if (!strategyValid(binding.primary_test_strategy_id)) {
        issues.push(
          issue(
            "primary_strategy_tdd_invalid",
            `primary strategy ${binding.primary_test_strategy_id} is not a test_strategy artifact with a TDD entry for ${entry.requirement_id}`,
            { target_id: binding.primary_test_strategy_id },
          ),
        );
      }
    }
    const strategyTargets = new Set([
      entry.requirement_id,
      ...pairs.map((pair) => pair.test_node_id),
    ]);
    for (const supportingId of entry.supporting_test_strategy_ids) {
      if (!strategyValid(supportingId) || !hasEdge("SPECIFIES", supportingId, strategyTargets)) {
        issues.push(
          issue(
            "test_strategy_gap",
            `supporting strategy ${supportingId} is not a SPECIFIES-connected test_strategy for ${entry.requirement_id}`,
            { target_id: supportingId },
          ),
        );
      }
    }

    // Rule 4/5: api/data/ui applicability assets belong to the set and connect.
    const applicabilityTargets = new Set([
      entry.requirement_id,
      ...decisions,
      ...components,
      ...pairs.map((pair) => pair.test_node_id),
    ]);
    for (const domain of ["api", "data", "ui"] as const) {
      const applicability = entry.applicability[domain];
      if (applicability.status === "not_applicable") continue;
      for (const assetId of applicability.asset_ids) {
        if (!index.members.has(assetId)) {
          issues.push(
            issue(
              "applicability_gap",
              `${domain} applicability asset ${assetId} is not a member of this design set`,
              { target_id: assetId },
            ),
          );
          continue;
        }
        if (!hasEdge("SPECIFIES", assetId, applicabilityTargets)) {
          issues.push(
            issue(
              "applicability_gap",
              `${domain} applicability asset ${assetId} has no SPECIFIES edge into the requirement context`,
              { target_id: assetId },
            ),
          );
        }
      }
    }
  }

  // 7. Conflict: no duplicate assets or edge ids inside the proposal.
  const memberIds = [
    ...content.node_changes.map((change) => change.node_id),
    ...content.reused_assets.map((asset) => asset.node_id),
  ];
  const seenMembers = new Set<string>();
  for (const id of memberIds) {
    if (seenMembers.has(id)) {
      issues.push(
        issue("duplicate_asset", `asset ${id} appears more than once in the design set`, {
          target_id: id,
        }),
      );
    }
    seenMembers.add(id);
  }
  const seenEdges = new Set<string>();
  for (const edge of content.edge_changes) {
    if (seenEdges.has(edge.edge_id)) {
      issues.push(
        issue("duplicate_edge_id", `edge ${edge.edge_id} is declared more than once`, {
          target_id: edge.edge_id,
        }),
      );
    }
    seenEdges.add(edge.edge_id);
  }

  // 6b. Reuse mode never introduces silent revisions (design 9.2 rule 6).
  if (content.mode === "reuse" && content.node_changes.length > 0) {
    issues.push(
      issue("reuse_mode_violation", "mode reuse must not create or revise any design asset"),
    );
  }

  // 8. Risk: the declared level may never undercut the computed floor.
  let floor: number = RISK_RANK.low;
  for (const requirementId of mustChange) {
    const risk = input.requirement_impact_risks[requirementId];
    floor = Math.max(floor, RISK_RANK[risk ?? ("low" as keyof typeof RISK_RANK)] ?? 0);
  }
  for (const change of content.node_changes) {
    floor = Math.max(floor, RISK_RANK.medium);
    const artifact = artifactContentOf(index.members.get(change.node_id));
    if (artifact !== undefined) {
      floor = Math.max(floor, CONTRACT_KIND_FLOOR[artifact.artifact_kind] ?? 0);
    }
  }
  if (RISK_RANK[content.risk_summary.level] < floor) {
    issues.push(
      issue(
        "risk_understated",
        `declared risk ${content.risk_summary.level} undercuts the computed floor`,
      ),
    );
  }

  // 9/10. Canonicalization and round-trip stability are guaranteed by
  // canonicalizeDesignSetContent and pinned by the property tests; the
  // content digest a caller must seal is designSetContentDigest(content).
  return issues.sort((left, right) => left.code.localeCompare(right.code));
}
