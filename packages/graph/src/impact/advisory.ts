import { contentDigest, type NodeRecord } from "@universal-harness-internal/core";
import type {
  ImpactAdvisoryOutput,
  ImpactAdvisorySourceRef,
} from "@universal-harness-internal/core";

import { RELATION_COMPATIBILITY, isRelationCompatible } from "../integrity.js";
import type { ImpactEntry } from "./impact-set.js";

/**
 * Impact advisory merge validation (model advisory design 6, prompt
 * governance addendum PG-3). The advisory may only ADD to the deterministic
 * ImpactSet: it can never delete or reclassify an entry, undercut a
 * deterministic risk, sneak in a rule-violating or reversed edge, or cite
 * anything that is not verifiably the current graph/PRD/source. Every rule
 * failure is a typed issue; unknown shapes fail closed.
 */

/** The versioned relation rule registry advisory inputs are bound to. */
export const RELATION_RULE_REGISTRY = {
  version: "relation-rules.v1",
  rules: RELATION_COMPATIBILITY,
  digest: contentDigest(RELATION_COMPATIBILITY),
} as const;

export const IMPACT_ADVISORY_MERGE_ISSUE_CODES = [
  "stale_impact_set",
  "registry_drift",
  "deterministic_entry_mutation",
  "classification_overreach",
  "risk_downgrade",
  "relation_rule_violation",
  "citation_invalid",
] as const;
export type ImpactAdvisoryMergeIssueCode = (typeof IMPACT_ADVISORY_MERGE_ISSUE_CODES)[number];

export interface ImpactAdvisoryMergeIssue {
  readonly code: ImpactAdvisoryMergeIssueCode;
  readonly target_id?: string;
  readonly message: string;
}

export interface ImpactAdvisoryMergeInput {
  readonly output: ImpactAdvisoryOutput;
  readonly deterministic_entries: readonly ImpactEntry[];
  readonly impact_set_digest: string;
  readonly nodes: readonly NodeRecord[];
  /** Accepted-PRD requirement id → content digest. */
  readonly requirement_digests: Readonly<Record<string, string>>;
  readonly rule_registry_version: string;
  readonly rule_registry_digest: string;
}

const RISK_ORDER: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2 };

function issue(
  code: ImpactAdvisoryMergeIssueCode,
  message: string,
  targetId?: string,
): ImpactAdvisoryMergeIssue {
  return { code, message, ...(targetId === undefined ? {} : { target_id: targetId }) };
}

function citationValid(
  ref: ImpactAdvisorySourceRef,
  nodeDigests: ReadonlyMap<string, string>,
  requirementDigests: Readonly<Record<string, string>>,
): boolean {
  if (ref.kind === "graph_node") {
    return nodeDigests.get(ref.ref) === ref.digest;
  }
  if (ref.kind === "requirement") {
    return requirementDigests[ref.ref] === ref.digest;
  }
  // Context sources are digested by the context layer; the advisory input
  // carries only graph/requirement truth, so source claims verify as
  // requirements do when the caller maps them into requirement_digests.
  if (ref.kind === "context_source") {
    return requirementDigests[ref.ref] === ref.digest;
  }
  return false;
}

function allCitationsValid(
  refs: readonly ImpactAdvisorySourceRef[],
  nodeDigests: ReadonlyMap<string, string>,
  requirementDigests: Readonly<Record<string, string>>,
): boolean {
  return refs.every((ref) => citationValid(ref, nodeDigests, requirementDigests));
}

export function validateImpactAdvisoryMerge(
  input: ImpactAdvisoryMergeInput,
): ImpactAdvisoryMergeIssue[] {
  const issues: ImpactAdvisoryMergeIssue[] = [];
  const { output } = input;

  if (output.impact_set_digest !== input.impact_set_digest) {
    issues.push(
      issue(
        "stale_impact_set",
        `advisory targets impact set ${output.impact_set_digest}, expected ${input.impact_set_digest}`,
      ),
    );
  }
  if (
    input.rule_registry_version !== RELATION_RULE_REGISTRY.version ||
    input.rule_registry_digest !== RELATION_RULE_REGISTRY.digest
  ) {
    issues.push(
      issue(
        "registry_drift",
        "relation rule registry version or digest drifted from the shipped table",
      ),
    );
  }

  const nodeDigests = new Map(input.nodes.map((node) => [node.id, node.digest]));
  const nodeTypes = new Map(input.nodes.map((node) => [node.id, node.type]));
  const deterministicByNode = new Map(
    input.deterministic_entries.map((entry) => [entry.node_id, entry]),
  );

  for (const addition of output.additions) {
    if (deterministicByNode.has(addition.node_id)) {
      issues.push(
        issue(
          "deterministic_entry_mutation",
          `addition targets deterministic entry ${addition.node_id}; advisory output is additive only`,
          addition.node_id,
        ),
      );
    }
    if (addition.classification === "must-change") {
      issues.push(
        issue(
          "classification_overreach",
          `advisory addition ${addition.node_id} claims must-change; model candidates cap at inspect`,
          addition.node_id,
        ),
      );
    }
    if (!allCitationsValid(addition.source_refs, nodeDigests, input.requirement_digests)) {
      issues.push(
        issue(
          "citation_invalid",
          `addition ${addition.node_id} carries an unverifiable citation`,
          addition.node_id,
        ),
      );
    }
  }

  for (const candidate of output.edge_candidates) {
    const sourceType = nodeTypes.get(candidate.source_id);
    const targetType = nodeTypes.get(candidate.target_id);
    const compatible =
      sourceType !== undefined &&
      targetType !== undefined &&
      isRelationCompatible(
        candidate.relation as Parameters<typeof isRelationCompatible>[0],
        sourceType,
        targetType,
      );
    if (!compatible) {
      issues.push(
        issue(
          "relation_rule_violation",
          `edge candidate ${candidate.source_id} -[${candidate.relation}]-> ${candidate.target_id} violates the relation registry`,
          candidate.source_id,
        ),
      );
    }
    if (!allCitationsValid(candidate.source_refs, nodeDigests, input.requirement_digests)) {
      issues.push(
        issue(
          "citation_invalid",
          `edge candidate ${candidate.source_id} carries an unverifiable citation`,
          candidate.source_id,
        ),
      );
    }
  }

  for (const signal of output.risk_signals) {
    const deterministic = deterministicByNode.get(signal.node_id);
    if (
      deterministic !== undefined &&
      (RISK_ORDER[signal.risk] ?? -1) < (RISK_ORDER[deterministic.risk] ?? 0)
    ) {
      issues.push(
        issue(
          "risk_downgrade",
          `risk signal on ${signal.node_id} undercuts the deterministic risk ${deterministic.risk}`,
          signal.node_id,
        ),
      );
    }
    if (!allCitationsValid(signal.source_refs, nodeDigests, input.requirement_digests)) {
      issues.push(
        issue(
          "citation_invalid",
          `risk signal on ${signal.node_id} carries an unverifiable citation`,
          signal.node_id,
        ),
      );
    }
  }

  for (const fact of output.missing_facts) {
    if (!allCitationsValid(fact.source_refs, nodeDigests, input.requirement_digests)) {
      issues.push(
        issue(
          "citation_invalid",
          `missing fact ${fact.subject_id} carries an unverifiable citation`,
          fact.subject_id,
        ),
      );
    }
  }

  return issues.sort((left, right) => left.code.localeCompare(right.code));
}
