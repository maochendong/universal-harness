import { describe, expect, it } from "vitest";

import { contentDigest, type NodeRecord } from "@universal-harness-internal/core";

import {
  canonicalizeDesignSetContent,
  designSetContentDigest,
  validateDesignSetProposal,
  type DesignSetValidationInput,
} from "../../src/design/validator.js";

/**
 * Deterministic property tests for DesignSet canonicalization and validation
 * (designset lifecycle design 19.2, plan T11): any input ordering yields the
 * same content digest, a JSON round-trip preserves the digest, and illegal
 * references, relations or revisions can never pass validation. A seeded
 * PRNG keeps every run reproducible.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = Array.from({ length: 16 }, (_, index) => index + 1);

const digest = (letter: string) => letter.repeat(64);
const REQUIREMENT_ID = "requirement_01K1REQ";
const CRITERION_ID = "criterion_01K1AC1";
const TEST_ID = "test_01K1T01";
const DECISION_ID = "decision_01K1DEC";
const STRATEGY_ID = "designartifact_01K1TST";

function graphNodes(): NodeRecord[] {
  const make = (type: NodeRecord["type"], id: string): NodeRecord => {
    const record: Record<string, unknown> = {
      protocol_version: "1.0.0",
      record_kind: "node",
      id,
      type,
      revision: 1,
      status: "accepted",
      source: "workflow",
      provenance: {
        iteration_id: "iteration_01",
        actor: "design-property-test",
        timestamp: "2026-08-20T00:00:00Z",
      },
      confidence: 1,
    };
    return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
  };
  return [make("Requirement", REQUIREMENT_ID), make("Test", TEST_ID)];
}

function validContent() {
  return {
    requirement_baseline_digest: digest("b"),
    impact_set_id: "impactset_01K1IMP",
    impact_set_digest: digest("1"),
    policy_digest: digest("2"),
    repository_baseline: "deadbeef",
    mode: "change",
    node_changes: [
      {
        action: "create",
        node_id: DECISION_ID,
        node_type: "Decision",
        target_revision: 1,
        proposed_extensions: { "harness.decision": { summary: "decide" } },
      },
      {
        action: "create",
        node_id: STRATEGY_ID,
        node_type: "DesignArtifact",
        target_revision: 1,
        proposed_extensions: {
          "harness.design_artifact": {
            artifact_kind: "test_strategy",
            title: "s",
            summary: "s",
            assumptions: [],
            acceptance_implications: [],
            body_format: "structured",
            body: {
              scenarios: ["s"],
              test_levels: ["unit"],
              required_gates: [],
              required_evidence: [],
              tdd: [
                {
                  requirement_id: REQUIREMENT_ID,
                  applicability: {
                    status: "not_applicable",
                    category: "trivial_copy",
                    reason: "no behavioural change",
                  },
                },
              ],
            },
          },
        },
      },
    ],
    reused_assets: [],
    edge_changes: [
      {
        action: "create",
        edge_id: "edge_01K1E01",
        relation: "ADDRESSES",
        source_id: DECISION_ID,
        target_id: REQUIREMENT_ID,
      },
      {
        action: "create",
        edge_id: "edge_01K1E02",
        relation: "SPECIFIES",
        source_id: STRATEGY_ID,
        target_id: TEST_ID,
      },
    ],
    coverage: [
      {
        requirement_id: REQUIREMENT_ID,
        decision_ids: [DECISION_ID],
        component_scope: { status: "not_applicable", reason: "no component change" },
        test_strategy_coverage: [
          {
            acceptance_criterion_id: CRITERION_ID,
            test_node_id: TEST_ID,
            primary_test_strategy_id: STRATEGY_ID,
          },
        ],
        supporting_test_strategy_ids: [],
        applicability: {
          api: { status: "not_applicable", reason: "no api" },
          data: { status: "not_applicable", reason: "no data" },
          ui: { status: "not_applicable", reason: "no ui" },
        },
      },
    ],
    risk_summary: { level: "medium", reasons: ["impact medium"] },
    rationale: "cover the requirement",
  };
}

function baseInput(content: unknown): DesignSetValidationInput {
  return {
    content,
    bindings: {
      requirement_baseline_digest: digest("b"),
      impact_set_id: "impactset_01K1IMP",
      impact_set_digest: digest("1"),
      policy_digest: digest("2"),
      repository_baseline: "deadbeef",
    },
    nodes: graphNodes(),
    edges: [],
    must_change_requirement_ids: [REQUIREMENT_ID],
    requirement_impact_risks: { [REQUIREMENT_ID]: "medium" },
    criterion_test_pairs: [
      {
        requirement_id: REQUIREMENT_ID,
        acceptance_criterion_id: CRITERION_ID,
        test_node_id: TEST_ID,
      },
    ],
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

describe("design set canonicalization properties", () => {
  it("produces the same content digest for any input ordering", () => {
    const reference = designSetContentDigest(validContent() as never);
    for (const seed of SEEDS) {
      const random = mulberry32(seed);
      const content = validContent();
      const shuffled = {
        ...content,
        node_changes: shuffle(content.node_changes, random),
        edge_changes: shuffle(content.edge_changes, random),
        coverage: content.coverage.map((entry) => ({
          ...entry,
          test_strategy_coverage: shuffle(entry.test_strategy_coverage, random),
        })),
      };
      expect(designSetContentDigest(shuffled as never)).toBe(reference);
      // Round-trip: serialize and re-read the canonical form.
      const canonical = canonicalizeDesignSetContent(shuffled as never);
      expect(designSetContentDigest(JSON.parse(JSON.stringify(canonical)))).toBe(reference);
      expect(validateDesignSetProposal(baseInput(shuffled))).toEqual([]);
    }
  });

  it("never lets illegal references, relations or revisions pass", () => {
    for (const seed of SEEDS) {
      const random = mulberry32(seed);
      const content = validContent() as unknown as Record<string, unknown>;
      const mutation = Math.floor(random() * 5);
      if (mutation === 0) {
        (content.edge_changes as Array<Record<string, unknown>>)[0].target_id =
          "requirement_01K1MIA";
      } else if (mutation === 1) {
        (content.edge_changes as Array<Record<string, unknown>>)[0].relation = "SHAPES";
      } else if (mutation === 2) {
        (content.node_changes as Array<Record<string, unknown>>)[0].target_revision = 7;
      } else if (mutation === 3) {
        const changes = content.node_changes as unknown[];
        content.node_changes = [...changes, changes[0]];
      } else {
        content.coverage = [];
      }
      expect(validateDesignSetProposal(baseInput(content)).length).toBeGreaterThan(0);
    }
  });
});
