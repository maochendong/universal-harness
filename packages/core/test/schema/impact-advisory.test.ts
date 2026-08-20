import { describe, expect, it } from "vitest";

import {
  ImpactAdvisoryOutputSchema,
  ImpactAdvisoryRecordSchema,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  compileSchemaValidator,
  sealRecordEnvelope,
} from "../../src/index.js";

const validateOutput = compileSchemaValidator(ImpactAdvisoryOutputSchema);
const validateRecord = compileSchemaValidator(ImpactAdvisoryRecordSchema);

const REF = { kind: "graph_node", ref: "requirement_01K1ABC", digest: "b".repeat(64) } as const;

function validOutput() {
  return {
    purpose: "impact_advisory" as const,
    schema_version: "impact-advisory.v1" as const,
    impact_set_digest: "a".repeat(64),
    additions: [
      {
        node_id: "code-artifact_01K1ABC",
        node_type: "CodeArtifact",
        classification: "inspect",
        risk: "medium",
        confidence: 0.7,
        reason: "the export path touches the reporting module",
        source_refs: [REF],
      },
    ],
    edge_candidates: [],
    risk_signals: [],
    missing_facts: [],
    questions: [],
  };
}

describe("impact advisory output schema", () => {
  it("is registered in the protocol 1.1 registry", () => {
    const documents = PROTOCOL_1_1_SCHEMA_REGISTRY.documents();
    expect(documents["impact-advisory-output.schema.json"]).toBeDefined();
    expect(documents["impact-advisory.schema.json"]).toBeDefined();
  });

  it("accepts a fully cited advisory output", () => {
    expect(validateOutput(validOutput()).valid).toBe(true);
  });

  it("rejects uncited candidates, unknown fields and out-of-range confidence", () => {
    const base = validOutput();
    const uncited = structuredClone(base);
    uncited.additions[0]!.source_refs = [];
    expect(validateOutput(uncited).valid).toBe(false);

    const extra = { ...base, auto_apply: true };
    expect(validateOutput(extra).valid).toBe(false);

    const confident = structuredClone(base);
    confident.additions[0]!.confidence = 1.2;
    expect(validateOutput(confident).valid).toBe(false);
  });

  it("rejects candidates that would mutate the deterministic set by shape", () => {
    const tampered = validOutput() as Record<string, unknown>;
    tampered["remove_entries"] = ["code-artifact_01K1ABC"];
    tampered["downgrade_risk_to"] = "low";
    expect(validateOutput(tampered).valid).toBe(false);
  });

  it("seals the advisory record with registry and rule-registry digests", () => {
    const record = sealRecordEnvelope({
      protocol_version: "1.1.0",
      record_kind: "impact_advisory" as const,
      impact_advisory_id: "impact-advisory_01K1ABC",
      workflow_operation_id: "operation_01K1ABC",
      iteration_id: "iteration_01K1ABC",
      impact_set_digest: "a".repeat(64),
      relation_rule_registry_version: "relation-rules.v1",
      relation_rule_registry_digest: "c".repeat(64),
      binding_digest: "d".repeat(64),
      conversation_id: "conversation_01K1ABC",
      run_id: "run_01K1ABC",
      input_digest: "e".repeat(64),
      output: validOutput(),
    });
    expect(validateRecord(record).valid).toBe(true);
    expect(validateRecord({ ...record, relation_rule_registry_digest: undefined }).valid).toBe(
      false,
    );
  });
});
