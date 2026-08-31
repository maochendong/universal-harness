import { describe, expect, it } from "vitest";

import {
  CapabilityCompileError,
  compileCapabilityPlan,
  type CapabilityPlanCompileInput,
} from "../../src/capability/compiler.js";
import {
  OperationDagError,
  buildOperationDag,
  validateOperationDag,
} from "../../src/capability/dag.js";
import {
  CAPABILITY_MODULE_DEFINITIONS,
  CAPABILITY_MODULE_DEFINITIONS_1_3,
  CapabilityRegistryError,
  capabilityDependencyClosure,
  capabilityModuleDefinition,
  capabilityModuleDefinitionsForProtocol,
  registeredCapabilityIds,
} from "../../src/capability/registry.js";
import { contentDigest } from "../../src/identity/digest.js";
import { createProfileDecisionRecord } from "../../src/profile/decisions.js";
import { createProjectProfileRecord } from "../../src/profile/records.js";
import type { ProfileId } from "../../src/schema/profile.js";
import { CAPABILITY_IDS_1_1 } from "../../src/schema/profile.js";
import { CapabilityPlanRecordV13Schema } from "../../src/schema/capability.js";
import { compileSchemaValidator } from "../../src/schema/validator.js";
import { createTestPromptContractRegistry } from "../prompt/helpers.js";
import type { ModelProviderConfig } from "../../src/capability/compiler.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_F = "f".repeat(64);
const DIGEST_G = "0".repeat(64);
const TIMESTAMP = "2026-08-19T00:00:00.000Z";
const PROJECT_ID = "project_demo-app";
const OPERATION_ID = "operation_01K1ABCDEFGHIJKLMNO";
const ALL_PROVIDERS = ["isolated_workspace_provider", "structured_gate_provider"] as const;

/** Legacy Protocol 1.1 DAG bytes, pinned before the 1.3 extension landed. */
const LEGACY_GOVERNED_DAG_DIGEST =
  "49cbe9286194eaf0c197abbd4e9c177569b63d1ca08b73b876f88a3e022b62cd";
const LEGACY_LITE_DAG_DIGEST = "70859fb2c641503592f7c15ba685757a1286c692cda910d8a230801ec44498a2";
/** Legacy 1.1 module definition digests that must never rotate. */
const LEGACY_MODULE_DIGESTS: Readonly<Record<string, string>> = {
  impact_analysis: "5f859616f65f181cbf96837cbe63373fe4d25916f00001fa3676c7b1b1dbfad1",
  design_governance: "11107db527629eca474627986196b9dd3f1c24fa6b2a9c6b17ccadea71d39fd0",
  independent_evaluation: "529007c985edc670ab8deedd80cb2e592b6d61cbddb81533bfd6fe8f0e7352ca",
  strict_tdd: "644012e6268b0c1a8a9a689c9bce2281e4140016edd97ec04fc094009e56cffd",
  advanced_audit: "1e37b3481b43e808b1b22c4593d280f8300efd2ba5244e5515bbcb923cd51c77",
};

describe("parallel_task_execution module contract", () => {
  it("registers the exact slim module contract at version 1.3.0", () => {
    const module = capabilityModuleDefinition("parallel_task_execution", "1.3.0");
    expect(module).toMatchObject({
      capability_id: "parallel_task_execution",
      version: "1.3.0",
      depends_on: [],
      required_providers: ["isolated_workspace_provider", "structured_gate_provider"],
      input_bindings: ["execution_plan", "context_bundle"],
      output_bindings: ["wave_integration"],
      checkpoint_boundary: "execute",
      invalidated_by: ["execution_plan", "context_bundle"],
      approval_objects: [],
    });
    expect(module.definition_digest).toMatch(/^[a-f0-9]{64}$/);
    const { definition_digest: digest, ...rest } = module;
    expect(contentDigest(rest)).toBe(digest);
  });

  it("does not exist for protocol 1.1/1.2 readers", () => {
    expect(() => capabilityModuleDefinition("parallel_task_execution")).toThrow(
      CapabilityRegistryError,
    );
    expect(() => capabilityModuleDefinition("parallel_task_execution", "1.1.0")).toThrow(
      CapabilityRegistryError,
    );
    expect(() => capabilityModuleDefinition("parallel_task_execution", "1.2.0")).toThrow(
      CapabilityRegistryError,
    );
    expect(() => capabilityDependencyClosure(["parallel_task_execution"])).toThrow(
      CapabilityRegistryError,
    );
  });

  it("selects versioned module lists without touching the 1.1 registry", () => {
    expect(capabilityModuleDefinitionsForProtocol("1.1.0")).toHaveLength(5);
    expect(capabilityModuleDefinitionsForProtocol("1.2.0")).toHaveLength(5);
    expect(capabilityModuleDefinitionsForProtocol("1.3.0")).toHaveLength(6);
    expect(CAPABILITY_MODULE_DEFINITIONS).toHaveLength(5);
    expect(CAPABILITY_MODULE_DEFINITIONS_1_3.map((module) => module.capability_id)).toEqual([
      ...CAPABILITY_MODULE_DEFINITIONS.map((module) => module.capability_id),
      "parallel_task_execution",
    ]);
    expect(registeredCapabilityIds()).toEqual([...CAPABILITY_IDS_1_1].sort());
    expect(registeredCapabilityIds("1.3.0")).toContain("parallel_task_execution");
    expect(() => capabilityModuleDefinitionsForProtocol("9.9.9")).toThrow(CapabilityRegistryError);
  });

  it("keeps every legacy 1.1 module digest byte-identical", () => {
    for (const [capabilityId, digest] of Object.entries(LEGACY_MODULE_DIGESTS)) {
      expect(capabilityModuleDefinition(capabilityId).definition_digest, capabilityId).toBe(digest);
      expect(capabilityModuleDefinition(capabilityId).version, capabilityId).toBe("1.1.0");
    }
  });
});

describe("protocol 1.3 operation dag", () => {
  it("puts parallel_task_execution as the sole execute subgraph when both capabilities are active", () => {
    const dag = buildOperationDag(new Set(["strict_tdd", "parallel_task_execution"]), "1.3.0");
    const execute = dag.find((node) => node.node_id === "execute");
    expect(execute?.subgraph).toBe("parallel_task_execution");
    // Strict TDD keeps contributing its contract bindings to the execute node;
    // the Scheduler invokes StrictTddExecutionPort per Task inside the outer
    // parallel subgraph instead of nesting a second subgraph.
    expect(execute?.consumes).toContain("design_set");
    expect(execute?.produces).toContain("tdd_contract");
    expect(execute?.consumes).toContain("execution_plan");
    expect(execute?.consumes).toContain("context_bundle");
    expect(execute?.produces).toContain("wave_integration");
    // gate_evidence keeps a single producer: the Kernel verify node.
    expect(dag.filter((node) => node.produces.includes("gate_evidence"))).toHaveLength(1);
    expect(dag.find((node) => node.node_id === "verify")?.produces).toContain("gate_evidence");
    // No dedicated module node and no nested generic subgraph.
    expect(dag.some((node) => node.capability_id === "parallel_task_execution")).toBe(false);
    // The dependency-closed set (with impact/design pulled in by strict_tdd)
    // passes structural validation.
    const closed = buildOperationDag(
      new Set(capabilityDependencyClosure(["strict_tdd", "parallel_task_execution"], "1.3.0")),
      "1.3.0",
    );
    expect(closed.find((node) => node.node_id === "execute")?.subgraph).toBe(
      "parallel_task_execution",
    );
    expect(() => validateOperationDag(closed)).not.toThrow();
  });

  it("keeps the strict_tdd subgraph when parallel execution is inactive", () => {
    const dag = buildOperationDag(new Set(["strict_tdd"]), "1.3.0");
    expect(dag.find((node) => node.node_id === "execute")?.subgraph).toBe("strict_tdd");
    expect(
      dag.some(
        (node) =>
          node.consumes.includes("wave_integration") || node.produces.includes("wave_integration"),
      ),
    ).toBe(false);
  });

  it("marks execute with the parallel subgraph when only parallel execution is active", () => {
    const dag = buildOperationDag(new Set(["parallel_task_execution"]), "1.3.0");
    const execute = dag.find((node) => node.node_id === "execute");
    expect(execute?.subgraph).toBe("parallel_task_execution");
    expect(execute?.produces).toEqual(["wave_integration"]);
    expect(() => validateOperationDag(dag)).not.toThrow();
  });

  it("fails closed when a 1.1 dag is asked to schedule in parallel", () => {
    expect(() => buildOperationDag(new Set(["parallel_task_execution"]))).toThrow(
      OperationDagError,
    );
    expect(() => buildOperationDag(new Set(["parallel_task_execution"]), "1.1.0")).toThrowError(
      expect.objectContaining({ kind: "unknown_capability" }),
    );
  });

  it("keeps legacy protocol 1.1 dag bytes stable", () => {
    const governed = new Set(CAPABILITY_IDS_1_1);
    expect(contentDigest(buildOperationDag(governed))).toBe(LEGACY_GOVERNED_DAG_DIGEST);
    expect(contentDigest(buildOperationDag(governed, "1.1.0"))).toBe(LEGACY_GOVERNED_DAG_DIGEST);
    expect(contentDigest(buildOperationDag(new Set(), "1.1.0"))).toBe(LEGACY_LITE_DAG_DIGEST);
  });
});

function providerConfig(slotId: string, purpose?: string): ModelProviderConfig {
  return {
    slot_id: slotId as ModelProviderConfig["slot_id"],
    ...(purpose === undefined ? {} : { purpose: purpose as never }),
    provider_identity: "provider_anthropic",
    config_digest: "e".repeat(64),
    prompt_version: `${slotId}.v1`,
    schema_version: `${slotId}-result.v1`,
    budget_profile: "operation-standard",
  };
}

const OPERATION_SCOPE_CONFIGS: readonly ModelProviderConfig[] = [
  providerConfig("impact_advisory"),
  providerConfig("design_review"),
  providerConfig("plan_proposal"),
  providerConfig("feedback_analysis"),
  providerConfig("grounded_synthesis", "context_enrichment"),
  providerConfig("grounded_synthesis", "iteration_narrative"),
];

function compileInput(
  profileId: ProfileId,
  overrides: Partial<CapabilityPlanCompileInput> = {},
): CapabilityPlanCompileInput {
  const project_profile = createProjectProfileRecord({
    project_id: PROJECT_ID,
    revision: 1,
    profile_id: profileId,
    policy_digest: DIGEST_A,
    actor: "human:reviewer",
    effective_from: TIMESTAMP,
  });
  const profile_decision = createProfileDecisionRecord({
    decision_kind: "project_profile_change",
    project_id: PROJECT_ID,
    actor: "human:reviewer",
    idempotency_key: `profile-decision:${PROJECT_ID}:1`,
    current_profile_id: profileId,
    decided_profile_id: profileId,
    policy_digest: DIGEST_A,
    decided_at: TIMESTAMP,
  });
  return {
    operation_id: OPERATION_ID,
    stage: "final",
    project_profile,
    profile_decision,
    requirement_digest: DIGEST_B,
    risk_digest: DIGEST_C,
    policy_digest: DIGEST_A,
    baseline_digest: DIGEST_D,
    model_providers: OPERATION_SCOPE_CONFIGS,
    prompt_contract_resolver: createTestPromptContractRegistry(),
    ...overrides,
  };
}

describe("capability compiler under protocol 1.3", () => {
  const validateV13 = compileSchemaValidator(CapabilityPlanRecordV13Schema);

  it("emits a protocol 1.3 capability plan when the parallel module participates", () => {
    const plan = compileCapabilityPlan(
      compileInput("governed", { protocol_version: "1.3.0", providers: ALL_PROVIDERS }),
    );
    expect(plan.protocol_version).toBe("1.3.0");
    const entry = plan.capabilities.find(
      (candidate) => candidate.capability_id === "parallel_task_execution",
    );
    expect(entry).toMatchObject({
      resolution: "active",
      resolution_source: "profile_required",
      module_version: "1.3.0",
      module_digest: capabilityModuleDefinition("parallel_task_execution", "1.3.0")
        .definition_digest,
    });
    expect(plan.capabilities).toHaveLength(6);
    const execute = plan.operation_dag.nodes.find((node) => node.node_id === "execute");
    expect(execute?.subgraph).toBe("parallel_task_execution");
    expect(validateV13(plan)).toEqual({ valid: true, errors: [] });
  });

  it("resolves standard 1.3 parallel execution as required in both compilation stages", () => {
    const provisional = compileCapabilityPlan(
      compileInput("standard", {
        protocol_version: "1.3.0",
        stage: "provisional",
        providers: ALL_PROVIDERS,
      }),
    );
    expect(provisional.protocol_version).toBe("1.3.0");
    expect(
      provisional.capabilities.find((entry) => entry.capability_id === "parallel_task_execution")
        ?.resolution,
    ).toBe("active");
    expect(
      provisional.capabilities.find((entry) => entry.capability_id === "strict_tdd")?.resolution,
    ).toBe("deferred");

    const final = compileCapabilityPlan(
      compileInput("standard", {
        protocol_version: "1.3.0",
        stage: "final",
        providers: ALL_PROVIDERS,
        accepted_design_set: { design_set_digest: DIGEST_F, test_strategy_digest: DIGEST_G },
        supersedes: provisional,
      }),
    );
    expect(final.protocol_version).toBe("1.3.0");
    expect(final.revision).toBe(provisional.revision + 1);
    expect(final.operation_dag.nodes.find((node) => node.node_id === "execute")?.subgraph).toBe(
      "parallel_task_execution",
    );
    expect(validateV13(final)).toEqual({ valid: true, errors: [] });
  });

  it("keeps lite 1.3 on the legacy sequential plan: no scheduling invocation", () => {
    const plan = compileCapabilityPlan(
      compileInput("lite", {
        protocol_version: "1.3.0",
        providers: ALL_PROVIDERS,
        model_providers: [],
      }),
    );
    // The module is disabled, so nothing 1.3-specific participates: the plan
    // stays a legacy 1.1 record with no parallel entry and no wave bindings.
    expect(plan.protocol_version).toBe("1.1.0");
    expect(plan.capabilities).toHaveLength(5);
    expect(
      plan.capabilities.some((entry) => entry.capability_id === "parallel_task_execution"),
    ).toBe(false);
    expect(
      plan.operation_dag.nodes.find((node) => node.node_id === "execute")?.subgraph,
    ).toBeUndefined();
    expect(
      plan.operation_dag.nodes.some(
        (node) =>
          node.produces.includes("wave_integration" as never) ||
          node.consumes.includes("wave_integration" as never),
      ),
    ).toBe(false);
  });

  it("rejects a policy deny of a profile-required parallel module", () => {
    try {
      compileCapabilityPlan(
        compileInput("governed", {
          protocol_version: "1.3.0",
          providers: ALL_PROVIDERS,
          policy: { denied_capabilities: ["parallel_task_execution" as never] },
        }),
      );
      expect.unreachable("denying a required capability must block compilation");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityCompileError);
      expect((error as CapabilityCompileError).kind).toBe("policy_conflict");
    }
  });

  it("fails closed when a 1.1 compilation is asked to activate parallel execution", () => {
    try {
      compileCapabilityPlan(
        compileInput("lite", {
          activations: [
            { capability_id: "parallel_task_execution" as never, source: "user_activation" },
          ],
        }),
      );
      expect.unreachable("unknown capabilities must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityRegistryError);
    }
  });

  it("requires the module providers before a 1.3 plan can go parallel", () => {
    try {
      compileCapabilityPlan(compileInput("governed", { protocol_version: "1.3.0" }));
      expect.unreachable("missing providers must block compilation");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityCompileError);
      expect((error as CapabilityCompileError).kind).toBe("missing_provider");
    }
  });
});
