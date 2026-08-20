import { describe, expect, it } from "vitest";

import { contentDigest } from "@universal-harness-internal/core";

import { makeNode } from "../fixtures.js";
import {
  RELATION_RULE_REGISTRY,
  validateImpactAdvisoryMerge,
  type ImpactAdvisoryMergeInput,
} from "../../src/impact/advisory.js";
import type { ImpactEntry } from "../../src/impact/impact-set.js";

const SET_DIGEST = "a".repeat(64);

const NODES = [
  makeNode({ id: "requirement_01", type: "Requirement" }),
  makeNode({ id: "code-artifact_02", type: "CodeArtifact" }),
  makeNode({ id: "task_03", type: "Task" }),
];
const NODE_DIGEST = new Map(NODES.map((node) => [node.id, node.digest]));

function graphRef(nodeId: string) {
  return { kind: "graph_node" as const, ref: nodeId, digest: NODE_DIGEST.get(nodeId)! };
}

function deterministicEntry(): ImpactEntry {
  return {
    node_id: "requirement_01",
    node_type: "Requirement",
    classification: "must-change",
    risk: "high",
    confidence: 1,
    path: [],
    reason: "directly seeded",
    seed_id: "seed_01",
  };
}

function baseOutput() {
  return {
    purpose: "impact_advisory" as const,
    schema_version: "impact-advisory.v1" as const,
    impact_set_digest: SET_DIGEST,
    additions: [
      {
        node_id: "code-artifact_02",
        node_type: "CodeArtifact",
        classification: "inspect" as const,
        risk: "medium" as const,
        confidence: 0.7,
        reason: "the export path touches the reporting module",
        source_refs: [graphRef("code-artifact_02")],
      },
    ],
    edge_candidates: [],
    risk_signals: [],
    missing_facts: [],
    questions: [],
  };
}

function input(overrides: Partial<ImpactAdvisoryMergeInput> = {}): ImpactAdvisoryMergeInput {
  return {
    output: baseOutput(),
    deterministic_entries: [deterministicEntry()],
    impact_set_digest: SET_DIGEST,
    nodes: NODES,
    requirement_digests: {},
    rule_registry_version: RELATION_RULE_REGISTRY.version,
    rule_registry_digest: RELATION_RULE_REGISTRY.digest,
    ...overrides,
  };
}

function issueCodes(inputValue: ImpactAdvisoryMergeInput): string[] {
  return validateImpactAdvisoryMerge(inputValue).map((issue) => issue.code);
}

describe("impact advisory additive merge validator", () => {
  it("accepts a clean additive advisory", () => {
    expect(validateImpactAdvisoryMerge(input())).toEqual([]);
  });

  it("rejects any write targeting a deterministic entry", () => {
    const output = baseOutput();
    output.additions = [
      {
        node_id: "requirement_01",
        node_type: "Requirement",
        classification: "informational",
        risk: "low",
        confidence: 0.9,
        reason: "downgrade the seeded requirement",
        source_refs: [graphRef("requirement_01")],
      },
    ];
    expect(issueCodes(input({ output }))).toContain("deterministic_entry_mutation");
  });

  it("caps model classifications below must-change", () => {
    const output = baseOutput();
    output.additions[0] = { ...output.additions[0]!, classification: "must-change" };
    expect(issueCodes(input({ output }))).toContain("classification_overreach");
  });

  it("rejects risk signals that undercut a deterministic entry's risk", () => {
    const output = baseOutput();
    output.additions = [];
    output.risk_signals = [
      {
        node_id: "requirement_01",
        signal: "looks safe actually",
        risk: "low",
        rationale: "the model disagrees with the deterministic high risk",
        source_refs: [graphRef("requirement_01")],
      },
    ];
    expect(issueCodes(input({ output }))).toContain("risk_downgrade");
  });

  it("rejects edge candidates that violate the relation registry or its direction", () => {
    const output = baseOutput();
    output.additions = [];
    output.edge_candidates = [
      {
        source_id: "requirement_01",
        target_id: "task_03",
        relation: "IMPLEMENTS",
        rationale: "reversed direction attempt",
        source_refs: [graphRef("requirement_01")],
      },
    ];
    const codes = issueCodes(input({ output }));
    expect(codes).toContain("relation_rule_violation");

    const unknown = baseOutput();
    unknown.additions = [];
    unknown.edge_candidates = [
      {
        source_id: "task_03",
        target_id: "requirement_01",
        relation: "OWNS",
        rationale: "invented relation",
        source_refs: [graphRef("task_03")],
      },
    ];
    expect(issueCodes(input({ output: unknown }))).toContain("relation_rule_violation");
  });

  it("rejects citations that do not match the current graph or registries", () => {
    const output = baseOutput();
    output.additions[0] = {
      ...output.additions[0]!,
      source_refs: [{ kind: "graph_node", ref: "code-artifact_02", digest: "0".repeat(64) }],
    };
    expect(issueCodes(input({ output }))).toContain("citation_invalid");

    const ghost = baseOutput();
    ghost.additions[0] = {
      ...ghost.additions[0]!,
      source_refs: [{ kind: "graph_node", ref: "code-artifact_99", digest: "0".repeat(64) }],
    };
    expect(issueCodes(input({ output: ghost }))).toContain("citation_invalid");
  });

  it("fails closed on stale impact sets and rule registry drift", () => {
    expect(issueCodes(input({ impact_set_digest: "9".repeat(64) }))).toContain("stale_impact_set");
    expect(issueCodes(input({ rule_registry_digest: "9".repeat(64) }))).toContain("registry_drift");
    expect(issueCodes(input({ rule_registry_version: "relation-rules.v99" }))).toContain(
      "registry_drift",
    );
  });

  it("pins the rule registry digest to the shipped compatibility table", () => {
    expect(RELATION_RULE_REGISTRY.version).toBe("relation-rules.v1");
    expect(RELATION_RULE_REGISTRY.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(RELATION_RULE_REGISTRY.digest).toBe(contentDigest(RELATION_RULE_REGISTRY.rules));
  });
});
