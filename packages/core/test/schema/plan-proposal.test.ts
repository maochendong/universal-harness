import { describe, expect, it } from "vitest";

import { PROTOCOL_1_1_SCHEMA_REGISTRY, sealRecordEnvelope } from "../../src/schema/index.js";

/**
 * T13/PG-5 plan proposal schemas (model advisory design 8): the model only
 * allocates Harness-compiled canonical assertions into task candidates — it
 * can never mint assertion ids, widen paths or weaken gates. The record
 * binds the exact input digest for resume and audit.
 */
const digest = (letter: string) => letter.repeat(64);

function goldenTask() {
  return {
    task_key: "task-export",
    goal: "implement the CSV export",
    atomicity_rationale: "single independently reviewable output",
    assertion_ids: ["criterion-assertion_01K1AS1"],
    requirement_ids: ["requirement_01K1REQ"],
    decision_ids: ["decision_01K1DEC"],
    design_artifact_ids: ["designartifact_01K1TST"],
    depends_on: [],
    suggested_gate_ids: ["gate_target"],
    suggested_write_paths: ["src/export/**"],
  };
}

describe("plan proposal output schema", () => {
  it("accepts the golden allocation output", () => {
    const output = {
      purpose: "plan_proposal",
      schema_version: "plan_proposal.v1",
      tasks: [goldenTask()],
      questions: [],
    };
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("plan-proposal-output", output).valid).toBe(true);
  });

  it("rejects stray fields and empty goals", () => {
    const extra = {
      purpose: "plan_proposal",
      schema_version: "plan_proposal.v1",
      tasks: [{ ...goldenTask(), command: "rm -rf ." }],
      questions: [],
    };
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("plan-proposal-output", extra).valid).toBe(false);

    const emptyGoal = {
      purpose: "plan_proposal",
      schema_version: "plan_proposal.v1",
      tasks: [{ ...goldenTask(), goal: "" }],
      questions: [],
    };
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("plan-proposal-output", emptyGoal).valid).toBe(
      false,
    );
  });
});

describe("plan proposal record", () => {
  it("seals and validates the envelope", () => {
    const record = sealRecordEnvelope({
      protocol_version: "1.1.0",
      record_kind: "plan_proposal",
      proposal_id: "plan-proposal_01K1P01",
      workflow_operation_id: "operation_01K1OP1",
      iteration_id: "iteration_01K1IT1",
      created_at: "2026-08-21T00:00:00.000Z",
      generator: { port: "in-memory-plan-proposal" },
      input_digest: digest("1"),
      output: {
        purpose: "plan_proposal",
        schema_version: "plan_proposal.v1",
        tasks: [goldenTask()],
        questions: [],
      },
    });
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("plan-proposal", record).valid).toBe(true);
  });
});
