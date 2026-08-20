import { describe, expect, it } from "vitest";

import {
  CapabilityCompileError,
  assertCapabilityPlanFinal,
  capabilityResolution,
  compileCapabilityPlan,
  invalidatedCapabilities,
  type CapabilityPlanCompileInput,
  type ModelProviderConfig,
} from "../../src/capability/compiler.js";
import {
  CapabilityRegistryError,
  capabilityModuleDefinition,
} from "../../src/capability/registry.js";
import { createProfileDecisionRecord } from "../../src/profile/decisions.js";
import { BindingScopeError } from "../../src/profile/model-slots.js";
import { createProjectProfileRecord } from "../../src/profile/records.js";
import type { CapabilityId, ProfileId } from "../../src/schema/profile.js";
import { bindingContractFields, createTestPromptContractRegistry } from "../prompt/helpers.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
const DIGEST_G = "0".repeat(64);
const DIGEST_H = "1".repeat(64);
const TIMESTAMP = "2026-08-19T00:00:00.000Z";
const PROJECT_ID = "project_demo-app";
const OPERATION_ID = "operation_01K1ABCDEFGHIJKLMNO";

const ALL_PROVIDERS = ["isolated_workspace_provider", "structured_gate_provider"] as const;

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
    prompt_contract_resolver: createTestPromptContractRegistry(),
    ...overrides,
  };
}

function providerConfig(
  slotId: string,
  purpose?: string,
  overrides: Partial<ModelProviderConfig> = {},
): ModelProviderConfig {
  return {
    slot_id: slotId as ModelProviderConfig["slot_id"],
    ...(purpose === undefined ? {} : { purpose: purpose as never }),
    provider_identity: "provider_anthropic",
    config_digest: DIGEST_E,
    prompt_version: `${slotId}.v1`,
    schema_version: `${slotId}-result.v1`,
    budget_profile: "operation-standard",
    ...overrides,
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

const DESIGN_SET = {
  design_set_digest: DIGEST_F,
  test_strategy_digest: DIGEST_G,
};

function expectCompileError(input: CapabilityPlanCompileInput, kind: string): void {
  try {
    compileCapabilityPlan(input);
    expect.unreachable(`expected compile blocker ${kind}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityCompileError);
    expect((error as CapabilityCompileError).kind, kind).toBe(kind);
  }
}

describe("capability compiler: lite kernel-only", () => {
  it("compiles a final lite plan with zero modules, bindings or module approvals", () => {
    const plan = compileCapabilityPlan(compileInput("lite"));
    expect(plan.compilation_stage).toBe("final");
    expect(plan.revision).toBe(1);
    expect(plan.profile_id).toBe("lite");
    expect(() => assertCapabilityPlanFinal(plan)).not.toThrow();

    for (const entry of plan.capabilities) {
      expect(entry.resolution).toBe("inactive_by_profile");
    }
    // Zero contributor invocation surface: no module nodes in the DAG.
    expect(plan.operation_dag.nodes.map((node) => node.node_id)).toEqual([
      "capture",
      "capability_decision",
      "plan",
      "context",
      "execute",
      "verify",
      "snapshot",
    ]);
    expect(plan.operation_dag.nodes.every((node) => node.node_kind === "kernel")).toBe(true);
    // Zero module artifacts and zero module approvals.
    const serialized = JSON.stringify(plan);
    for (const artifact of [
      "impact_set",
      "design_set",
      "evaluation_report",
      "audit_report",
      "tdd_contract",
    ]) {
      expect(serialized).not.toContain(artifact);
    }
    expect(plan.approval_objects).toEqual(["project_profile", "requirement_baseline"]);
    expect(plan.model_provider_bindings).toEqual([]);
    expect(plan.invalidation_graph).toEqual([]);
    expect(plan.providers).toEqual([]);
  });

  it("refuses a provisional stage where the protocol declares no deferral point", () => {
    expectCompileError(compileInput("lite", { stage: "provisional" }), "illegal_provisional_stage");
    expectCompileError(
      compileInput("governed", { stage: "provisional" }),
      "illegal_provisional_stage",
    );
  });

  it("activates strict_tdd by pulling in design_governance, impact_analysis and both providers", () => {
    const input = compileInput("lite", {
      activations: [{ capability_id: "strict_tdd", source: "user_activation" }],
      providers: [...ALL_PROVIDERS],
      // design_review becomes mandatory once design_governance is active.
      model_providers: [providerConfig("design_review"), providerConfig("impact_advisory")],
    });
    const plan = compileCapabilityPlan(input);
    const resolution = (id: CapabilityId) => capabilityResolution(plan, id);
    expect(resolution("strict_tdd").resolution).toBe("active");
    expect(resolution("strict_tdd").resolution_source).toBe("user_activation");
    expect(resolution("design_governance").resolution).toBe("active");
    expect(resolution("design_governance").resolution_source).toBe("dependency_closure");
    expect(resolution("impact_analysis").resolution).toBe("active");
    expect(resolution("impact_analysis").resolution_source).toBe("dependency_closure");
    expect(plan.providers).toEqual([...ALL_PROVIDERS]);
    expect(plan.operation_dag.nodes.map((node) => node.node_id)).toContain("design");
  });

  it("blocks strict_tdd activation without the structured gate and workspace providers", () => {
    const input = compileInput("lite", {
      activations: [{ capability_id: "strict_tdd", source: "user_activation" }],
      model_providers: [providerConfig("design_review"), providerConfig("impact_advisory")],
    });
    expectCompileError(input, "missing_provider");
    expectCompileError({ ...input, providers: ["structured_gate_provider"] }, "missing_provider");
  });

  it("runs provider closure for capability-activated lite slots instead of degrading silently", () => {
    // impact_analysis active on Lite makes impact_advisory mandatory; no config → blocker.
    expectCompileError(
      compileInput("lite", {
        activations: [{ capability_id: "impact_analysis", source: "risk_activation" }],
      }),
      "missing_model_provider",
    );
  });

  it("compiles optional lite slots only when a provider is explicitly configured", () => {
    const plan = compileCapabilityPlan(
      compileInput("lite", { model_providers: [providerConfig("plan_proposal")] }),
    );
    expect(plan.model_provider_bindings).toHaveLength(1);
    expect(plan.model_provider_bindings[0]).toMatchObject({
      slot_id: "plan_proposal",
      required: false,
      failure_mode: "block",
    });
  });

  it("rejects activations of unknown or policy-denied capabilities", () => {
    expect(() =>
      compileCapabilityPlan(
        compileInput("lite", {
          activations: [{ capability_id: "quantum_review" as never, source: "user_activation" }],
        }),
      ),
    ).toThrow(CapabilityRegistryError);
    expectCompileError(
      compileInput("lite", {
        activations: [{ capability_id: "advanced_audit", source: "user_activation" }],
        policy: { denied_capabilities: ["advanced_audit"] },
      }),
      "policy_deny_not_overridable",
    );
  });
});

describe("capability compiler: governed", () => {
  it("compiles a final plan with all modules, providers and bindings", () => {
    const plan = compileCapabilityPlan(
      compileInput("governed", {
        providers: [...ALL_PROVIDERS],
        model_providers: OPERATION_SCOPE_CONFIGS,
      }),
    );
    expect(plan.compilation_stage).toBe("final");
    for (const entry of plan.capabilities) {
      expect(entry.resolution).toBe("active");
      expect(entry.resolution_source).toBe("profile_required");
    }
    expect(plan.providers).toEqual([...ALL_PROVIDERS]);
    expect(plan.operation_dag.nodes.map((node) => node.node_id)).toEqual([
      "capture",
      "capability_decision",
      "impact",
      "design",
      "plan",
      "context",
      "execute",
      "verify",
      "evaluate",
      "snapshot",
      "audit",
    ]);
    expect(plan.model_provider_bindings).toHaveLength(6);
    expect(plan.model_provider_bindings.every((binding) => binding.required)).toBe(true);
    const narrative = plan.model_provider_bindings.find(
      (binding) => binding.purpose === "iteration_narrative",
    );
    expect(narrative?.failure_mode).toBe("projection_finding");
    expect(plan.approval_objects).toEqual([
      "design_set",
      "impact_set",
      "project_profile",
      "requirement_baseline",
    ]);
  });

  it("blocks a profile-required capability the policy denies", () => {
    expectCompileError(
      compileInput("governed", {
        providers: [...ALL_PROVIDERS],
        model_providers: OPERATION_SCOPE_CONFIGS,
        policy: { denied_capabilities: ["strict_tdd"] },
      }),
      "policy_conflict",
    );
  });
});

describe("capability compiler: standard strict_tdd two-phase resolution", () => {
  function provisionalInput(): CapabilityPlanCompileInput {
    return compileInput("standard", {
      stage: "provisional",
      model_providers: OPERATION_SCOPE_CONFIGS,
    });
  }

  it("defers strict_tdd at the provisional stage and blocks plan entry", () => {
    const plan = compileCapabilityPlan(provisionalInput());
    expect(plan.compilation_stage).toBe("provisional");
    expect(capabilityResolution(plan, "strict_tdd")).toMatchObject({
      resolution: "deferred",
      resolution_source: "awaiting_design_set",
    });
    expect(capabilityResolution(plan, "impact_analysis").resolution).toBe("active");
    expect(capabilityResolution(plan, "design_governance").resolution).toBe("active");
    expect(() => assertCapabilityPlanFinal(plan)).toThrow(CapabilityCompileError);
    try {
      assertCapabilityPlanFinal(plan);
      expect.unreachable("provisional plans must not enter plan");
    } catch (error) {
      expect((error as CapabilityCompileError).kind).toBe("plan_not_final");
    }
  });

  it("finalizes only behind an accepted design set, in one superseding revision", () => {
    const provisional = compileCapabilityPlan(provisionalInput());

    // No accepted DesignSet → finalization is blocked.
    expectCompileError(
      { ...provisionalInput(), stage: "final", supersedes: provisional },
      "design_set_required",
    );
    // Standard never compiles final without its provisional revision.
    expectCompileError(
      compileInput("standard", {
        model_providers: OPERATION_SCOPE_CONFIGS,
        providers: [...ALL_PROVIDERS],
        accepted_design_set: DESIGN_SET,
      }),
      "provisional_required",
    );

    const final = compileCapabilityPlan({
      ...provisionalInput(),
      stage: "final",
      providers: [...ALL_PROVIDERS],
      accepted_design_set: DESIGN_SET,
      supersedes: provisional,
    });
    expect(final.compilation_stage).toBe("final");
    expect(final.revision).toBe(provisional.revision + 1);
    expect(final.supersedes_digest).toBe(provisional.record_digest);
    expect(final.profile_decision_digest).toBe(provisional.profile_decision_digest);
    expect(final.design_set_digest).toBe(DESIGN_SET.design_set_digest);
    expect(final.test_strategy_digest).toBe(DESIGN_SET.test_strategy_digest);
    expect(capabilityResolution(final, "strict_tdd")).toMatchObject({
      resolution: "active",
      resolution_source: "design_set_finalization",
      binding_digest: DESIGN_SET.test_strategy_digest,
    });
    expect(() => assertCapabilityPlanFinal(final)).not.toThrow();
    // strict_tdd active at final → provider closure applies.
    expect(final.providers).toEqual([...ALL_PROVIDERS]);
  });

  it("blocks finalization when the decision or inputs drifted since the provisional", () => {
    const provisional = compileCapabilityPlan(provisionalInput());
    expectCompileError(
      {
        ...provisionalInput(),
        stage: "final",
        providers: [...ALL_PROVIDERS],
        accepted_design_set: DESIGN_SET,
        supersedes: provisional,
        requirement_digest: DIGEST_H,
      },
      "supersede_mismatch",
    );
    const otherDecisionInput = compileInput("standard", { stage: "provisional" });
    const otherDecision = createProfileDecisionRecord({
      decision_kind: "project_profile_change",
      project_id: PROJECT_ID,
      actor: "human:reviewer",
      idempotency_key: `profile-decision:${PROJECT_ID}:2`,
      current_profile_id: "standard",
      decided_profile_id: "standard",
      policy_digest: DIGEST_A,
      decided_at: TIMESTAMP,
    });
    expectCompileError(
      {
        ...otherDecisionInput,
        profile_decision: otherDecision,
        stage: "final",
        providers: [...ALL_PROVIDERS],
        accepted_design_set: DESIGN_SET,
        supersedes: provisional,
        model_providers: OPERATION_SCOPE_CONFIGS,
      },
      "supersede_mismatch",
    );
  });

  it("uses the fixed generic tail verify → evaluate → snapshot once evaluation is active", () => {
    const provisional = compileCapabilityPlan(provisionalInput());
    const final = compileCapabilityPlan({
      ...provisionalInput(),
      stage: "final",
      providers: [...ALL_PROVIDERS],
      accepted_design_set: DESIGN_SET,
      supersedes: provisional,
    });
    expect(final.operation_dag.nodes.map((node) => node.node_id).slice(-3)).toEqual([
      "verify",
      "evaluate",
      "snapshot",
    ]);
  });
});

describe("capability compiler: model provider binding rules", () => {
  const standardFinal = (
    overrides: Partial<CapabilityPlanCompileInput> = {},
  ): CapabilityPlanCompileInput => {
    const provisional = compileCapabilityPlan(
      compileInput("standard", { stage: "provisional", model_providers: OPERATION_SCOPE_CONFIGS }),
    );
    return compileInput("standard", {
      stage: "final",
      supersedes: provisional,
      accepted_design_set: DESIGN_SET,
      providers: [...ALL_PROVIDERS],
      model_providers: OPERATION_SCOPE_CONFIGS,
      ...overrides,
    });
  };

  it("compiles explicit bindings for every applicable operation-scope slot", () => {
    const plan = compileCapabilityPlan(standardFinal());
    const keys = plan.model_provider_bindings.map(
      (binding) => `${binding.slot_id}:${binding.purpose ?? ""}`,
    );
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      "design_review:",
      "feedback_analysis:",
      "grounded_synthesis:context_enrichment",
      "grounded_synthesis:iteration_narrative",
      "impact_advisory:",
      "plan_proposal:",
    ]);
  });

  it("blocks when a required provider is missing", () => {
    expectCompileError(
      standardFinal({
        model_providers: OPERATION_SCOPE_CONFIGS.filter(
          (config) => config.slot_id !== "design_review",
        ),
      }),
      "missing_model_provider",
    );
  });

  it("blocks unknown purposes and capture-scope slots in the operation scope", () => {
    expectCompileError(
      standardFinal({
        model_providers: [
          ...OPERATION_SCOPE_CONFIGS,
          providerConfig("grounded_synthesis", "executive_summary"),
        ],
      }),
      "unknown_purpose",
    );
    for (const purpose of ["project_discovery", "approval_brief"]) {
      expectCompileError(
        standardFinal({
          model_providers: [
            ...OPERATION_SCOPE_CONFIGS,
            providerConfig("grounded_synthesis", purpose),
          ],
        }),
        "capture_scope_slot",
      );
    }
    expectCompileError(
      standardFinal({
        model_providers: [
          ...OPERATION_SCOPE_CONFIGS,
          providerConfig("impact_advisory", "context_enrichment"),
        ],
      }),
      "unexpected_purpose",
    );
  });

  it("blocks version and budget conflicts between configs of one slot", () => {
    expectCompileError(
      standardFinal({
        model_providers: [
          ...OPERATION_SCOPE_CONFIGS,
          providerConfig("design_review", undefined, { prompt_version: "design_review.v2" }),
        ],
      }),
      "provider_config_conflict",
    );
    expectCompileError(
      standardFinal({
        model_providers: [
          ...OPERATION_SCOPE_CONFIGS,
          providerConfig("design_review", undefined, { budget_profile: "operation-deluxe" }),
        ],
      }),
      "provider_config_conflict",
    );
  });

  it("blocks failure modes that contradict the profile matrix", () => {
    expectCompileError(
      standardFinal({
        model_providers: OPERATION_SCOPE_CONFIGS.map((config) =>
          config.purpose === "iteration_narrative"
            ? { ...config, failure_mode: "block" as const }
            : config,
        ),
      }),
      "invalid_failure_mode",
    );
    expectCompileError(
      standardFinal({
        model_providers: OPERATION_SCOPE_CONFIGS.map((config) =>
          config.slot_id === "design_review"
            ? { ...config, failure_mode: "projection_finding" as const }
            : config,
        ),
      }),
      "invalid_failure_mode",
    );
  });

  it("keeps capture-scope slots out of the plan and verifies the scopes stay disjoint", () => {
    const discoveryContract = bindingContractFields(
      createTestPromptContractRegistry().resolve({
        port_id: "grounded_synthesis",
        purpose: "project_discovery",
        prompt_version: "project-discovery.v1",
      }),
    );
    const captureScopeBindings = [
      {
        slot_id: "grounded_synthesis" as const,
        purpose: "project_discovery" as const,
        required: true,
        provider_identity: "provider_anthropic",
        config_digest: DIGEST_E,
        prompt_version: "project-discovery.v1",
        schema_version: "project-discovery-result.v1",
        budget_profile: "capture-standard",
        failure_mode: "block" as const,
        ...discoveryContract,
      },
    ];
    const plan = compileCapabilityPlan(
      standardFinal({
        capture_scope_bindings: captureScopeBindings,
      }),
    );
    expect(
      plan.model_provider_bindings.every(
        (binding) =>
          binding.slot_id !== "grounded_synthesis" ||
          (binding.purpose !== "project_discovery" && binding.purpose !== "approval_brief"),
      ),
    ).toBe(true);

    // A capture-scope record that wrongly holds an operation-scope slot overlaps
    // with the compiled plan bindings and must be rejected deterministically.
    expect(() =>
      compileCapabilityPlan(
        standardFinal({
          capture_scope_bindings: [
            { ...captureScopeBindings[0], purpose: "context_enrichment" as const },
          ],
        }),
      ),
    ).toThrow(BindingScopeError);
  });

  it("rejects provider configs for slots that are not applicable", () => {
    expectCompileError(
      compileInput("lite", { model_providers: [providerConfig("impact_advisory")] }),
      "slot_not_applicable",
    );
  });

  it("derives every binding's contract fields from the injected resolver", () => {
    const registry = createTestPromptContractRegistry();
    const plan = compileCapabilityPlan(standardFinal({ prompt_contract_resolver: registry }));
    for (const binding of plan.model_provider_bindings) {
      const resolution = registry.resolve({
        port_id: binding.slot_id,
        ...(binding.purpose === undefined ? {} : { purpose: binding.purpose }),
        prompt_version: binding.prompt_version,
      });
      expect(binding.prompt_contract_id, binding.slot_id).toBe(resolution.prompt_contract_id);
      expect(binding.prompt_contract_version, binding.slot_id).toBe(
        resolution.prompt_contract_version,
      );
      expect(binding.prompt_contract_digest, binding.slot_id).toBe(
        resolution.prompt_contract_digest,
      );
      expect(binding.output_schema_digest, binding.slot_id).toBe(resolution.output_schema_digest);
    }
  });

  it("blocks when no resolver is injected but a binding must be compiled", () => {
    expectCompileError(
      standardFinal({ prompt_contract_resolver: undefined }),
      "prompt_contract_required",
    );
  });

  it("blocks unknown prompt versions instead of binding the nearest contract", () => {
    expectCompileError(
      standardFinal({
        model_providers: OPERATION_SCOPE_CONFIGS.map((config) =>
          config.slot_id === "design_review"
            ? { ...config, prompt_version: "design_review.v404" }
            : config,
        ),
      }),
      "prompt_contract_version_mismatch",
    );
  });

  it("rejects hand-supplied contract digests in provider configs fail-closed", () => {
    expectCompileError(
      standardFinal({
        model_providers: OPERATION_SCOPE_CONFIGS.map((config) =>
          config.slot_id === "design_review"
            ? ({ ...config, prompt_contract_digest: DIGEST_G } as never)
            : config,
        ),
      }),
      "prompt_contract_digest_mismatch",
    );
  });

  it("keeps lite compiles resolver-free when zero bindings are compiled", () => {
    const plan = compileCapabilityPlan(
      compileInput("lite", { prompt_contract_resolver: undefined }),
    );
    expect(plan.model_provider_bindings).toEqual([]);
  });
});

describe("capability compiler: invalidation graph", () => {
  it("records direct invalidation edges and resolves transitive drift", () => {
    const provisional = compileCapabilityPlan(
      compileInput("standard", { stage: "provisional", model_providers: OPERATION_SCOPE_CONFIGS }),
    );
    const plan = compileCapabilityPlan(
      compileInput("standard", {
        stage: "final",
        supersedes: provisional,
        accepted_design_set: DESIGN_SET,
        providers: [...ALL_PROVIDERS],
        model_providers: OPERATION_SCOPE_CONFIGS,
      }),
    );
    expect(plan.invalidation_graph).toEqual([
      { binding_kind: "design_set", invalidates: ["strict_tdd"] },
      { binding_kind: "gate_evidence", invalidates: ["independent_evaluation"] },
      { binding_kind: "impact_set", invalidates: ["design_governance"] },
      { binding_kind: "requirement_baseline", invalidates: ["impact_analysis"] },
    ]);
    // Requirement drift cascades through the dependency chain.
    expect(invalidatedCapabilities(plan, "requirement_baseline")).toEqual([
      "design_governance",
      "impact_analysis",
      "strict_tdd",
    ]);
    expect(invalidatedCapabilities(plan, "impact_set")).toEqual([
      "design_governance",
      "strict_tdd",
    ]);
    expect(invalidatedCapabilities(plan, "snapshot")).toEqual([]);
  });
});

describe("capability compiler: determinism", () => {
  it("produces the same plan digest for the same canonical input in any order", () => {
    const provisional = compileCapabilityPlan(
      compileInput("standard", { stage: "provisional", model_providers: OPERATION_SCOPE_CONFIGS }),
    );
    const shared = {
      stage: "final" as const,
      supersedes: provisional,
      accepted_design_set: DESIGN_SET,
      providers: [...ALL_PROVIDERS],
    };
    const first = compileCapabilityPlan(
      compileInput("standard", { ...shared, model_providers: OPERATION_SCOPE_CONFIGS }),
    );
    const second = compileCapabilityPlan(
      compileInput("standard", {
        ...shared,
        model_providers: [...OPERATION_SCOPE_CONFIGS].reverse(),
        providers: [...ALL_PROVIDERS].reverse(),
      }),
    );
    expect(second).toEqual(first);
    expect(second.record_digest).toBe(first.record_digest);
    expect(second.capability_plan_id).toBe(first.capability_plan_id);

    // A semantic change must change the digest.
    const changedProvisional = compileCapabilityPlan(
      compileInput("standard", {
        stage: "provisional",
        model_providers: OPERATION_SCOPE_CONFIGS,
        requirement_digest: DIGEST_H,
      }),
    );
    expect(changedProvisional.record_digest).not.toBe(provisional.record_digest);
  });
});

describe("capability resolution read api", () => {
  it("answers inactive_by_profile for capabilities the plan never enabled", () => {
    const plan = compileCapabilityPlan(compileInput("lite"));
    expect(capabilityResolution(plan, "strict_tdd")).toMatchObject({
      capability_id: "strict_tdd",
      resolution: "inactive_by_profile",
      resolution_source: "conditional_inactive",
      module_version: "1.1.0",
      module_digest: capabilityModuleDefinition("strict_tdd").definition_digest,
    });
    expect(() => capabilityResolution(plan, "quantum_review" as never)).toThrow(
      CapabilityRegistryError,
    );
  });
});
