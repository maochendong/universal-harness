import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compileCapabilityPlan,
  type CapabilityPlanCompileInput,
  type ModelProviderConfig,
} from "../../src/capability/compiler.js";
import { createProfileDecisionRecord } from "../../src/profile/decisions.js";
import { createProjectProfileRecord } from "../../src/profile/records.js";
import { verifyRecordEnvelope } from "../../src/schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import { createTestPromptContractRegistry } from "../prompt/helpers.js";

const goldenDirectory = join(dirname(fileURLToPath(import.meta.url)), "../golden/capability");

function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as T;
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
const DIGEST_G = "0".repeat(64);
const TIMESTAMP = "2026-08-19T00:00:00.000Z";
const PROJECT_ID = "project_demo-app";
const OPERATION_ID = "operation_01K1ABCDEFGHIJKLMNO";

function providerConfig(slotId: string, purpose?: string): ModelProviderConfig {
  return {
    slot_id: slotId as ModelProviderConfig["slot_id"],
    ...(purpose === undefined ? {} : { purpose: purpose as never }),
    provider_identity: "provider_anthropic",
    config_digest: DIGEST_E,
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

function standardCompileInput(
  overrides: Partial<CapabilityPlanCompileInput> = {},
): CapabilityPlanCompileInput {
  const project_profile = createProjectProfileRecord({
    project_id: PROJECT_ID,
    revision: 1,
    profile_id: "standard",
    policy_digest: DIGEST_A,
    actor: "human:reviewer",
    effective_from: TIMESTAMP,
  });
  const profile_decision = createProfileDecisionRecord({
    decision_kind: "project_profile_change",
    project_id: PROJECT_ID,
    actor: "human:reviewer",
    idempotency_key: `profile-decision:${PROJECT_ID}:1`,
    current_profile_id: "standard",
    decided_profile_id: "standard",
    policy_digest: DIGEST_A,
    decided_at: TIMESTAMP,
  });
  return {
    operation_id: OPERATION_ID,
    stage: "provisional",
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

function goldenProvisionalPlan() {
  return compileCapabilityPlan(standardCompileInput());
}

function goldenFinalPlan() {
  const provisional = goldenProvisionalPlan();
  return compileCapabilityPlan(
    standardCompileInput({
      stage: "final",
      supersedes: provisional,
      providers: ["isolated_workspace_provider", "structured_gate_provider"],
      accepted_design_set: {
        design_set_digest: DIGEST_F,
        test_strategy_digest: DIGEST_G,
      },
    }),
  );
}

describe("capability plan record schema", () => {
  it("validates the provisional and final golden plans through the registry", () => {
    for (const plan of [goldenProvisionalPlan(), goldenFinalPlan()]) {
      const record = plan as unknown as Record<string, unknown>;
      expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("capability-plan", record)).toEqual({
        valid: true,
        errors: [],
      });
      expect(verifyRecordEnvelope(record)).toBe(true);
    }
  });

  it("rejects unknown fields, illegal resolutions and malformed digests", () => {
    const plan = goldenFinalPlan() as unknown as Record<string, unknown>;
    const validate = (value: unknown) =>
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("capability-plan", value);
    expect(validate({ ...plan, unexpected: true }).valid).toBe(false);
    expect(validate({ ...plan, compilation_stage: "draft" }).valid).toBe(false);
    expect(validate({ ...plan, revision: 0 }).valid).toBe(false);
    expect(validate({ ...plan, requirement_digest: "not-a-digest" }).valid).toBe(false);
    expect(validate({ ...plan, protocol_version: "1.0.0" }).valid).toBe(false);

    const capabilities = plan["capabilities"] as object[];
    expect(
      validate({
        ...plan,
        capabilities: capabilities.map((entry, index) =>
          index === 0 ? { ...entry, resolution: "enabled" } : entry,
        ),
      }).valid,
    ).toBe(false);
    expect(
      validate({
        ...plan,
        model_provider_bindings: [
          { ...(plan["model_provider_bindings"] as object[])[0], failure_mode: "ignore" },
        ],
      }).valid,
    ).toBe(false);

    const digestless: Record<string, unknown> = { ...plan };
    delete digestless["record_digest"];
    expect(validate(digestless).valid).toBe(false);
    expect(verifyRecordEnvelope({ ...plan, revision: 3 })).toBe(false);
  });

  it("matches the committed golden fixtures byte for byte", () => {
    expect(goldenProvisionalPlan()).toEqual(readGolden("capability-plan-provisional.json"));
    expect(goldenFinalPlan()).toEqual(readGolden("capability-plan-final.json"));
  });
});
