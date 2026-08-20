import { describe, expect, it } from "vitest";

import { contentDigest, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";

import {
  canonicalizeDesignSetContent,
  designSetContentDigest,
  validateDesignSetProposal,
  type DesignSetValidationInput,
} from "../../src/design/validator.js";

/**
 * T11 deterministic DesignSet validation (designset lifecycle design 9/10):
 * an untrusted proposal is checked against committed graph facts only, in a
 * fixed pipeline order — shape, imperative content, reference, revision,
 * relation, coverage, conflict, risk, canonicalization, round-trip. Every
 * failure is a stable typed issue; the validator never repairs, never calls
 * a model and never writes anything.
 */
const digest = (letter: string) => letter.repeat(64);

let counter = 0;
function makeNode(
  type: NodeRecord["type"],
  spec: {
    readonly id?: string;
    readonly status?: NodeRecord["status"];
    readonly revision?: number;
    readonly extensions?: Record<string, unknown>;
  } = {},
): NodeRecord {
  counter += 1;
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: spec.id ?? `${type.toLowerCase()}_${String(counter).padStart(3, "0")}`,
    type,
    revision: spec.revision ?? 1,
    status: spec.status ?? "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "design-validator-test",
      timestamp: "2026-08-20T00:00:00Z",
    },
    confidence: 1,
    ...(spec.extensions === undefined ? {} : { extensions: spec.extensions }),
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

function makeEdge(
  relation: EdgeRecord["type"],
  sourceId: string,
  targetId: string,
  spec: { readonly id?: string; readonly status?: EdgeRecord["status"] } = {},
): EdgeRecord {
  counter += 1;
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "edge",
    id: spec.id ?? `edge_${String(counter).padStart(3, "0")}`,
    type: relation,
    source_id: sourceId,
    target_id: targetId,
    status: spec.status ?? "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "design-validator-test",
      timestamp: "2026-08-20T00:00:00Z",
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

const REQUIREMENT_ID = "requirement_01K1REQ";
const CRITERION_ID = "criterion_01K1AC1";
const TEST_ID = "test_01K1T01";
const DECISION_ID = "decision_01K1DEC";
const API_ARTIFACT_ID = "designartifact_01K1API";
const STRATEGY_ARTIFACT_ID = "designartifact_01K1TST";

function testStrategyExtension(requirementId: string) {
  return {
    "harness.design.artifact": {
      artifact_kind: "test_strategy",
      title: "items strategy",
      summary: "contract and unit tests",
      assumptions: [],
      acceptance_implications: [],
      body_format: "structured",
      body: {
        scenarios: ["happy path"],
        test_levels: ["unit"],
        required_gates: ["gate_target"],
        required_evidence: ["gate run record"],
        tdd: [
          {
            requirement_id: requirementId,
            applicability: {
              status: "required",
              baseline_guard_gates: ["gate_baseline"],
              target_gate: "gate_target",
              test_selectors: ["tests/items.test.ts"],
              failure_oracle: "the acceptance criterion holds",
              path_policy: {
                test: ["tests/**"],
                test_config: [],
                production: ["src/**"],
                immutable: [],
              },
              framework_profile_digest: digest("f"),
              refactor_policy: "behaviour-preserving edits only",
            },
          },
        ],
      },
    },
  };
}

function apiContractExtension() {
  return {
    "harness.design.artifact": {
      artifact_kind: "api_contract",
      title: "Items API",
      summary: "read-only items endpoint",
      assumptions: [],
      acceptance_implications: [],
      body_format: "structured",
      body: {
        protocol: "https+json",
        operations: ["GET /v1/items"],
        inputs: ["item id"],
        outputs: ["item document"],
        errors: ["404"],
        compatibility: "additive only",
      },
    },
  };
}

function goldenContent() {
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
        proposed_extensions: { "harness.decision": { summary: "expose items read API" } },
      },
      {
        action: "create",
        node_id: API_ARTIFACT_ID,
        node_type: "DesignArtifact",
        target_revision: 1,
        proposed_extensions: apiContractExtension(),
      },
      {
        action: "create",
        node_id: STRATEGY_ARTIFACT_ID,
        node_type: "DesignArtifact",
        target_revision: 1,
        proposed_extensions: testStrategyExtension(REQUIREMENT_ID),
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
        source_id: API_ARTIFACT_ID,
        target_id: REQUIREMENT_ID,
      },
      {
        action: "create",
        edge_id: "edge_01K1E03",
        relation: "SPECIFIES",
        source_id: STRATEGY_ARTIFACT_ID,
        target_id: TEST_ID,
      },
    ],
    coverage: [
      {
        requirement_id: REQUIREMENT_ID,
        decision_ids: [DECISION_ID],
        component_scope: { status: "not_applicable", reason: "read-only endpoint" },
        test_strategy_coverage: [
          {
            acceptance_criterion_id: CRITERION_ID,
            test_node_id: TEST_ID,
            primary_test_strategy_id: STRATEGY_ARTIFACT_ID,
          },
        ],
        supporting_test_strategy_ids: [],
        applicability: {
          api: { status: "covered", asset_ids: [API_ARTIFACT_ID] },
          data: { status: "not_applicable", reason: "no schema change" },
          ui: { status: "not_applicable", reason: "headless service" },
        },
      },
    ],
    risk_summary: { level: "high", reasons: ["new public API contract"] },
    rationale: "cover the items read requirement with an additive API contract",
  };
}

function baseInput(overrides: Partial<DesignSetValidationInput> = {}): DesignSetValidationInput {
  return {
    content: goldenContent(),
    bindings: {
      requirement_baseline_digest: digest("b"),
      impact_set_id: "impactset_01K1IMP",
      impact_set_digest: digest("1"),
      policy_digest: digest("2"),
      repository_baseline: "deadbeef",
    },
    nodes: [makeNode("Requirement", { id: REQUIREMENT_ID }), makeNode("Test", { id: TEST_ID })],
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
    ...overrides,
  };
}

function codes(input: DesignSetValidationInput): string[] {
  return validateDesignSetProposal(input).map((issue) => issue.code);
}

function mutatedContent(mutate: (content: Record<string, unknown>) => void): unknown {
  const content = goldenContent() as unknown as Record<string, unknown>;
  mutate(content);
  return content;
}

describe("validateDesignSetProposal", () => {
  it("accepts the golden proposal and canonicalizes deterministically", () => {
    expect(validateDesignSetProposal(baseInput())).toEqual([]);
    const canonical = canonicalizeDesignSetContent(goldenContent() as never);
    const digestA = designSetContentDigest(goldenContent() as never);
    const digestB = designSetContentDigest(JSON.parse(JSON.stringify(canonical)));
    expect(digestA).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestB).toBe(digestA);
  });

  it("fails closed on malformed shapes", () => {
    expect(codes(baseInput({ content: { mode: "change" } }))).toContain("shape_violation");
    expect(codes(baseInput({ content: "not an object" }))).toContain("shape_violation");
  });

  it("rejects embedded imperative content at any depth", () => {
    const content = mutatedContent((draft) => {
      const changes = draft.node_changes as Array<Record<string, unknown>>;
      (changes[0].proposed_extensions as Record<string, unknown>)["harness.decision"] = {
        summary: "x",
        nested: { shell_command: "rm -rf ." },
      };
    });
    expect(codes(baseInput({ content }))).toContain("imperative_content");
  });

  it("detects stale upstream bindings", () => {
    const content = mutatedContent((draft) => {
      draft.impact_set_digest = digest("9");
    });
    expect(codes(baseInput({ content }))).toContain("stale_binding");
  });

  it("enforces revision continuity and base digests", () => {
    const existing = makeNode("Decision", { id: DECISION_ID, revision: 3 });
    const revise = mutatedContent((draft) => {
      draft.node_changes = [
        {
          action: "revise",
          node_id: DECISION_ID,
          node_type: "Decision",
          target_revision: 4,
          base: { revision: 3, digest: existing.digest },
          proposed_extensions: { "harness.decision": { summary: "v4" } },
        },
        ...(draft.node_changes as unknown[]).slice(1),
      ];
    });
    expect(
      codes(baseInput({ content: revise, nodes: [...baseInput().nodes, existing] })),
    ).not.toContain("revision_skew");

    const skipped = mutatedContent((draft) => {
      const changes = draft.node_changes as Array<Record<string, unknown>>;
      changes[0] = { ...changes[0], target_revision: 2 };
    });
    expect(codes(baseInput({ content: skipped }))).toContain("revision_skew");

    const reviseUnknown = mutatedContent((draft) => {
      draft.node_changes = [
        {
          action: "revise",
          node_id: "decision_01K1MIA",
          node_type: "Decision",
          target_revision: 2,
          base: { revision: 1, digest: digest("d") },
          proposed_extensions: {},
        },
      ];
    });
    expect(codes(baseInput({ content: reviseUnknown }))).toContain("unknown_base_asset");
  });

  it("checks relation compatibility and endpoint existence", () => {
    const reversed = mutatedContent((draft) => {
      draft.edge_changes = [
        {
          action: "create",
          edge_id: "edge_01K1E09",
          relation: "ADDRESSES",
          source_id: REQUIREMENT_ID,
          target_id: DECISION_ID,
        },
      ];
    });
    expect(codes(baseInput({ content: reversed }))).toContain("relation_rule_violation");

    const dangling = mutatedContent((draft) => {
      draft.edge_changes = [
        {
          action: "create",
          edge_id: "edge_01K1E09",
          relation: "ADDRESSES",
          source_id: DECISION_ID,
          target_id: "requirement_01K1MIA",
        },
      ];
    });
    expect(codes(baseInput({ content: dangling }))).toContain("unknown_edge_endpoint");
  });

  it("enforces per-requirement coverage", () => {
    const missing = mutatedContent((draft) => {
      draft.coverage = [];
    });
    expect(codes(baseInput({ content: missing }))).toContain("missing_coverage");

    const unknownRequirement = mutatedContent((draft) => {
      const coverage = draft.coverage as Array<Record<string, unknown>>;
      coverage[0] = { ...coverage[0], requirement_id: "requirement_01K1OTH" };
    });
    expect(codes(baseInput({ content: unknownRequirement }))).toContain("unknown_requirement");

    const noDecision = mutatedContent((draft) => {
      const coverage = draft.coverage as Array<Record<string, unknown>>;
      coverage[0] = { ...coverage[0], decision_ids: [] };
    });
    expect(codes(baseInput({ content: noDecision }))).toContain("decision_coverage_gap");

    const noAddresses = mutatedContent((draft) => {
      draft.edge_changes = (draft.edge_changes as unknown[]).slice(1);
    });
    expect(codes(baseInput({ content: noAddresses }))).toContain("decision_coverage_gap");
  });

  it("enforces criterion-pair coverage exactly once", () => {
    const pairMissing = mutatedContent((draft) => {
      const coverage = draft.coverage as Array<Record<string, unknown>>;
      coverage[0] = { ...coverage[0], test_strategy_coverage: [] };
    });
    expect(codes(baseInput({ content: pairMissing }))).toContain("test_strategy_gap");

    const duplicated = mutatedContent((draft) => {
      const coverage = draft.coverage as Array<Record<string, unknown>>;
      const bindings = (coverage[0].test_strategy_coverage as unknown[]).slice();
      coverage[0] = { ...coverage[0], test_strategy_coverage: [...bindings, bindings[0]] };
    });
    expect(codes(baseInput({ content: duplicated }))).toContain("duplicate_criterion_coverage");
  });

  it("requires a valid TDD applicability on every primary strategy", () => {
    const noTdd = mutatedContent((draft) => {
      const changes = draft.node_changes as Array<Record<string, unknown>>;
      changes[2] = {
        ...changes[2],
        proposed_extensions: testStrategyExtension("requirement_01K1OTH"),
      };
    });
    expect(codes(baseInput({ content: noTdd }))).toContain("primary_strategy_tdd_invalid");
  });

  it("verifies applicability assets exist in the set and connect via SPECIFIES", () => {
    const unknownAsset = mutatedContent((draft) => {
      const coverage = draft.coverage as Array<Record<string, unknown>>;
      coverage[0] = {
        ...coverage[0],
        applicability: {
          ...(coverage[0].applicability as Record<string, unknown>),
          api: { status: "covered", asset_ids: ["designartifact_01K1MIA"] },
        },
      };
    });
    expect(codes(baseInput({ content: unknownAsset }))).toContain("applicability_gap");

    const noSpecifies = mutatedContent((draft) => {
      draft.edge_changes = (draft.edge_changes as Array<Record<string, unknown>>).filter(
        (edge) => edge.edge_id !== "edge_01K1E02",
      );
    });
    expect(codes(baseInput({ content: noSpecifies }))).toContain("applicability_gap");
  });

  it("rejects duplicate assets and silent revisions in reuse mode", () => {
    const duplicated = mutatedContent((draft) => {
      const changes = draft.node_changes as unknown[];
      draft.node_changes = [...changes, changes[0]];
    });
    expect(codes(baseInput({ content: duplicated }))).toContain("duplicate_asset");

    const reuse = mutatedContent((draft) => {
      draft.mode = "reuse";
    });
    expect(codes(baseInput({ content: reuse }))).toContain("reuse_mode_violation");
  });

  it("never lets the declared risk undercut the computed floor", () => {
    const understated = mutatedContent((draft) => {
      draft.risk_summary = { level: "low", reasons: ["trivial"] };
    });
    expect(codes(baseInput({ content: understated }))).toContain("risk_understated");
  });

  it("counts only accepted graph edges toward coverage, never inferred ones", () => {
    const existing = makeNode("Decision", { id: DECISION_ID });
    const proposedEdge = makeEdge("ADDRESSES", DECISION_ID, REQUIREMENT_ID, {
      status: "proposed",
    });
    const reusedProposal = mutatedContent((draft) => {
      draft.node_changes = (draft.node_changes as unknown[]).slice(1);
      draft.reused_assets = [
        { node_id: DECISION_ID, node_type: "Decision", revision: 1, digest: existing.digest },
      ];
      draft.edge_changes = (draft.edge_changes as Array<Record<string, unknown>>).filter(
        (edge) => edge.edge_id !== "edge_01K1E01",
      );
    });
    const result = codes(
      baseInput({
        content: reusedProposal,
        nodes: [...baseInput().nodes, existing],
        edges: [proposedEdge],
      }),
    );
    expect(result).toContain("decision_coverage_gap");
  });
});
