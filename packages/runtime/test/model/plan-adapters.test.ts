import { describe, expect, it, vi } from "vitest";

import {
  compileCriterionAssertions,
  createPromptContractRegistry,
} from "@universal-harness-internal/core";

import { readModelInvocationRecords } from "../../src/model/invocation-store.js";
import type { ManagedModelProviderPort } from "../../src/model/managed-runner.js";
import {
  createModelBackedPlanProposalPort,
  type PlanProposalAdapterDeps,
} from "../../src/model/plan-adapters.js";
import { PLAN_PROPOSAL_PROMPT_REGISTRATION } from "../../src/planning/plan-prompt-contract.js";
import type { PlanProposalInput } from "../../src/planning/plan-proposal.js";
import { makeTempDir } from "../bootstrap/helpers.js";

/**
 * PG-5 runtime adapter: the model-backed plan proposal port compiles its
 * isolated contract, invokes through the managed runner and re-validates the
 * allocation deterministically — a rejected allocation is never consumed.
 */
const digest = (letter: string) => letter.repeat(64);

const CRITERIA = [
  {
    criterion_id: "criterion_01K1AC1",
    criterion_semantic_digest: digest("a"),
    requirement_id: "requirement_01K1REQ",
    test_node_id: "test_01K1T01",
  },
];

function canonicalAssertions() {
  return compileCriterionAssertions(CRITERIA);
}

function proposalInput(): PlanProposalInput {
  return {
    workflow_operation_id: "operation_01K1OP1",
    iteration_id: "iteration_01K1IT1",
    requirement_baseline_digest: digest("b"),
    impact_set_digest: digest("1"),
    policy_digest: digest("2"),
    canonical_assertions: canonicalAssertions(),
    known_requirement_ids: ["requirement_01K1REQ"],
    known_decision_ids: [],
    known_design_artifact_ids: [],
    known_gate_ids: ["gate_target"],
    allowed_write_paths: ["src/**"],
    max_tasks: 24,
    bundle_digest: digest("7"),
    conversation_id: "conversation_01K1CV1",
    run_id: "run_01K1RN1",
  };
}

function cleanOutput() {
  return {
    purpose: "plan_proposal",
    schema_version: "plan_proposal.v1",
    tasks: [
      {
        task_key: "task-export",
        goal: "implement the CSV export",
        atomicity_rationale: "single independently reviewable output",
        assertion_ids: [canonicalAssertions()[0]?.assertion_id ?? ""],
        requirement_ids: ["requirement_01K1REQ"],
        decision_ids: [],
        design_artifact_ids: [],
        depends_on: [],
        suggested_gate_ids: ["gate_target"],
        suggested_write_paths: ["src/export/**"],
      },
    ],
    questions: [],
  };
}

const REGISTRY = createPromptContractRegistry([PLAN_PROPOSAL_PROMPT_REGISTRATION]);

function proposalDeps(root: string, provider: ManagedModelProviderPort): PlanProposalAdapterDeps {
  return {
    projectRoot: root,
    registry: REGISTRY,
    profile_id: "standard",
    provider_config: {
      provider_identity: "provider_anthropic",
      config_digest: "0".repeat(64),
      budget_profile: "operation-standard",
    },
    provider,
  };
}

function providerReturning(output: unknown): ManagedModelProviderPort {
  return { invoke: vi.fn(async () => ({ ok: true as const, content: JSON.stringify(output) })) };
}

describe("model-backed plan proposal adapter", () => {
  it("compiles, invokes, validates and consumes a clean allocation", async () => {
    const root = makeTempDir("harness-plan-proposal-");
    const port = createModelBackedPlanProposalPort(
      proposalDeps(root, providerReturning(cleanOutput())),
    );
    const result = await port.propose(proposalInput());
    expect(result.status).toBe("proposed");
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated", "consumed"]);
  });

  it("fails closed on an allocation the validator rejects and never consumes it", async () => {
    const root = makeTempDir("harness-plan-proposal-forged-");
    const forged = cleanOutput();
    forged.tasks[0] = {
      ...forged.tasks[0],
      assertion_ids: ["criterion-assertion_forged"],
    } as (typeof forged.tasks)[0];
    const port = createModelBackedPlanProposalPort(proposalDeps(root, providerReturning(forged)));
    const result = await port.propose(proposalInput());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("invalid_output");
      expect(result.failure.summary).toContain("unknown_assertion");
    }
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated"]);
  });

  it("passes a clarification request through without consuming the invocation", async () => {
    const root = makeTempDir("harness-plan-proposal-clarify-");
    const port = createModelBackedPlanProposalPort(
      proposalDeps(
        root,
        providerReturning({
          purpose: "plan_proposal",
          schema_version: "plan_proposal.v1",
          tasks: [],
          questions: [
            {
              question: "Which gate owns the export task?",
              target_id: "criterion_01K1AC1",
            },
          ],
        }),
      ),
    );
    const result = await port.propose(proposalInput());
    expect(result.status).toBe("clarification_required");
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated"]);
  });
});
