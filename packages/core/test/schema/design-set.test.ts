import { describe, expect, it } from "vitest";

import {
  DESIGN_ARTIFACT_KINDS,
  DESIGN_SEMANTIC_RELATIONS,
  NODE_TYPES,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  RELATION_TYPES,
  SCHEMA_EXPORT_DOCUMENTS,
  sealRecordEnvelope,
} from "../../src/schema/index.js";

const validateProposal = (value: unknown) =>
  PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-set-proposal", value);

const digest = (letter: string) => letter.repeat(64);

/**
 * T11 DesignSet schema (designset lifecycle design 7/9): the proposal record
 * is a strict Protocol 1.1 domain record; artifact bodies are validated per
 * kind profile; the new node types and the SPECIFIES relation join the
 * shared registries. Unknown shapes fail closed.
 */
function apiContractBody() {
  return {
    protocol: "https+json",
    operations: ["GET /v1/items"],
    inputs: ["item id"],
    outputs: ["item document"],
    errors: ["404 not_found"],
    compatibility: "additive fields only",
  };
}

function tddRequiredEntry(requirementId: string) {
  return {
    requirement_id: requirementId,
    applicability: {
      status: "required",
      baseline_guard_gates: ["gate_baseline"],
      target_gate: "gate_target",
      test_selectors: ["tests/items.test.ts"],
      failure_oracle: "the documented acceptance criterion holds",
      path_policy: {
        test: ["tests/**"],
        test_config: ["vitest.config.ts"],
        production: ["src/**"],
        immutable: ["migrations/**"],
      },
      framework_profile_digest: digest("f"),
      refactor_policy: "behaviour-preserving edits only",
    },
  };
}

function testStrategyBody(requirementId: string) {
  return {
    scenarios: ["happy path", "unknown item"],
    test_levels: ["unit", "integration"],
    required_gates: ["gate_target"],
    required_evidence: ["gate run record"],
    tdd: [tddRequiredEntry(requirementId)],
  };
}

function goldenContent() {
  return {
    requirement_baseline_digest: digest("b"),
    impact_set_id: "impactset_01K1ABC",
    impact_set_digest: digest("1"),
    policy_digest: digest("2"),
    repository_baseline: "deadbeef",
    mode: "change",
    node_changes: [
      {
        action: "create",
        node_id: "decision_01K1DEC",
        node_type: "Decision",
        target_revision: 1,
        proposed_extensions: { "harness.decision": { summary: "expose items read API" } },
      },
      {
        action: "create",
        node_id: "designartifact_01K1API",
        node_type: "DesignArtifact",
        target_revision: 1,
        proposed_extensions: {
          "harness.design.artifact": {
            artifact_kind: "api_contract",
            title: "Items API",
            summary: "read-only items endpoint",
            assumptions: ["single tenant"],
            acceptance_implications: ["criterion ac_1 covered by contract test"],
            body_format: "structured",
            body: apiContractBody(),
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
        source_id: "decision_01K1DEC",
        target_id: "requirement_01K1REQ",
      },
    ],
    coverage: [
      {
        requirement_id: "requirement_01K1REQ",
        decision_ids: ["decision_01K1DEC"],
        component_scope: {
          status: "not_applicable",
          reason: "pure read endpoint, no new component",
        },
        test_strategy_coverage: [
          {
            acceptance_criterion_id: "criterion_01K1AC1",
            test_node_id: "test_01K1T01",
            primary_test_strategy_id: "designartifact_01K1TST",
          },
        ],
        supporting_test_strategy_ids: [],
        applicability: {
          api: { status: "covered", asset_ids: ["designartifact_01K1API"] },
          data: { status: "not_applicable", reason: "read-only, no schema change" },
          ui: { status: "not_applicable", reason: "headless service" },
        },
      },
    ],
    risk_summary: { level: "medium", reasons: ["new public endpoint"] },
    rationale: "cover the items read requirement with an additive API contract",
  };
}

function goldenProposal() {
  return sealRecordEnvelope({
    protocol_version: "1.1.0",
    record_kind: "design_set_proposal",
    proposal_id: "designsetproposal_01K1P01",
    workflow_operation_id: "operation_01K1OP1",
    iteration_id: "iteration_01K1IT1",
    created_at: "2026-08-20T00:00:00.000Z",
    generator: { port: "dsh-design", model: "test-model", run_id: "run_01K1RUN" },
    content: goldenContent(),
    content_digest: digest("c"),
  });
}

describe("design set proposal schema", () => {
  it("accepts the golden proposal through the registry", () => {
    const proposal = goldenProposal();
    expect(validateProposal(proposal).valid).toBe(true);
    expect(Object.keys(SCHEMA_EXPORT_DOCUMENTS)).toContain("design-set-proposal.schema.json");
  });

  it("rejects extra fields and empty rationale at the envelope level", () => {
    const extra = { ...goldenProposal(), unexpected: true };
    expect(validateProposal(extra).valid).toBe(false);

    const noRationale = goldenProposal();
    (noRationale.content as Record<string, unknown>).rationale = "";
    expect(validateProposal(noRationale).valid).toBe(false);
  });

  it("validates artifact bodies against the per-kind profile", () => {
    const validateArtifact = (value: unknown) =>
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-artifact-content", value);

    const unknownKind = {
      artifact_kind: "database_schema",
      title: "t",
      summary: "s",
      assumptions: [],
      acceptance_implications: [],
      body_format: "structured",
      body: apiContractBody(),
    };
    expect(validateArtifact(unknownKind).valid).toBe(false);

    const bodylessApi = {
      artifact_kind: "api_contract",
      title: "t",
      summary: "s",
      assumptions: [],
      acceptance_implications: [],
      body_format: "structured",
      body: { protocol: "https+json" },
    };
    expect(validateArtifact(bodylessApi).valid).toBe(false);

    const notApplicableWithoutReason = {
      artifact_kind: "test_strategy",
      title: "t",
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
            requirement_id: "requirement_01K1REQ",
            applicability: { status: "not_applicable", category: "documentation", reason: "" },
          },
        ],
      },
    };
    expect(validateArtifact(notApplicableWithoutReason).valid).toBe(false);

    const validStrategy = {
      artifact_kind: "test_strategy",
      title: "t",
      summary: "s",
      assumptions: [],
      acceptance_implications: [],
      body_format: "structured",
      body: testStrategyBody("requirement_01K1REQ"),
    };
    expect(validateArtifact(validStrategy).valid).toBe(true);
  });

  it("registers the new node types, relations and artifact kinds", () => {
    expect(NODE_TYPES).toContain("DesignSet");
    expect(NODE_TYPES).toContain("DesignArtifact");
    expect(RELATION_TYPES).toContain("SPECIFIES");
    expect(DESIGN_SEMANTIC_RELATIONS).toEqual(["ADDRESSES", "SHAPES", "SPECIFIES"]);
    expect(DESIGN_ARTIFACT_KINDS).toEqual([
      "api_contract",
      "data_contract",
      "test_strategy",
      "ui_design",
    ]);
  });
});
