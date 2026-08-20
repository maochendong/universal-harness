import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ProfileBindingError,
  compileCaptureModelProviderBindings,
  createCaptureModelProviderBindingRecord,
  createProjectProfileRecord,
} from "../../src/profile/records.js";
import { createProfileRecommendationRecord } from "../../src/profile/recommendation.js";
import { createProfileDecisionRecord } from "../../src/profile/decisions.js";
import { verifyRecordEnvelope } from "../../src/schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import { PROJECT_DISCOVERY_PROMPT_CONTRACT } from "../../src/synthesis/prompt-contracts.js";
import { createCapturePromptContractRegistry } from "../prompt/helpers.js";

const goldenDirectory = join(dirname(fileURLToPath(import.meta.url)), "../golden/profile");

function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as T;
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
const TIMESTAMP = "2026-08-19T00:00:00.000Z";
const PROJECT_ID = "project_demo-app";
const ITERATION_ID = "iteration_01K1ABCDEFGHIJKLMNO";

function goldenProjectProfile() {
  return createProjectProfileRecord({
    project_id: PROJECT_ID,
    revision: 1,
    profile_id: "lite",
    policy_digest: DIGEST_A,
    actor: "human:reviewer",
    effective_from: TIMESTAMP,
  });
}

function goldenRecommendation() {
  const recommendation = createProfileRecommendationRecord({
    project_id: PROJECT_ID,
    iteration_id: ITERATION_ID,
    current_profile_id: "lite",
    triggered: ["public_api_change", "cross_component_change"],
    risk_object_digest: DIGEST_B,
    requirement_digest: DIGEST_C,
    scope_digest: DIGEST_D,
    policy_digest: DIGEST_A,
    rationale: "本次变更触及公共 API 并跨多个组件，建议至少 Standard。",
    scope_reduction_hint: "可将公共 API 变更拆分为独立迭代以降低档位。",
  });
  if (recommendation === undefined) throw new Error("expected a recommendation");
  return recommendation;
}

function goldenDecision() {
  return createProfileDecisionRecord({
    decision_kind: "override_recommendation",
    project_id: PROJECT_ID,
    iteration_id: ITERATION_ID,
    actor: "human:reviewer",
    reason: "团队确认公共 API 变更仅影响内部消费者，接受本次保持 Lite。",
    recommendation: goldenRecommendation(),
    current_profile_id: "lite",
    decided_profile_id: "lite",
    requirement_digest: DIGEST_C,
    risk_digest: DIGEST_B,
    scope_digest: DIGEST_D,
    policy_digest: DIGEST_A,
    idempotency_key: "profile-decision:iteration_01K1ABCDEFGHIJKLMNO:1",
    decided_at: TIMESTAMP,
  });
}

function goldenCaptureBindings() {
  return compileCaptureModelProviderBindings({
    prompt_contract_resolver: createCapturePromptContractRegistry(),
    configs: [
      {
        slot_id: "grounded_synthesis",
        purpose: "project_discovery",
        required: true,
        provider_identity: "provider_anthropic",
        config_digest: DIGEST_C,
        prompt_version: "project-discovery.v1",
        schema_version: "project-discovery-result.v1",
        budget_profile: "capture-standard",
        failure_mode: "block",
      },
      {
        slot_id: "grounded_synthesis",
        purpose: "approval_brief",
        required: true,
        provider_identity: "provider_anthropic",
        config_digest: DIGEST_C,
        prompt_version: "approval-brief.v1",
        schema_version: "approval-brief-result.v1",
        budget_profile: "capture-standard",
        failure_mode: "block",
      },
    ],
  });
}

function goldenCaptureBinding() {
  return createCaptureModelProviderBindingRecord({
    project_id: PROJECT_ID,
    profile_decision_id: "profile-decision_01K1ABCDEFGHIJKLMNO",
    profile_decision_digest: DIGEST_E,
    policy_digest: DIGEST_A,
    config_digest: DIGEST_F,
    baseline_digest: DIGEST_B,
    bindings: goldenCaptureBindings(),
  });
}

describe("profile record schemas", () => {
  it("validates the golden fixtures through the protocol 1.1 registry", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["project-profile", goldenProjectProfile() as unknown as Record<string, unknown>],
      ["profile-recommendation", goldenRecommendation() as unknown as Record<string, unknown>],
      ["profile-decision", goldenDecision() as unknown as Record<string, unknown>],
      ["model-provider-binding", goldenCaptureBinding() as unknown as Record<string, unknown>],
    ];
    for (const [key, record] of cases) {
      expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate(key, record), key).toEqual({
        valid: true,
        errors: [],
      });
      expect(verifyRecordEnvelope(record), key).toBe(true);
    }
  });

  it("rejects unknown fields, invalid enums, empty reasons and malformed digests", () => {
    const profile = goldenProjectProfile() as unknown as Record<string, unknown>;
    const validateProfile = (value: unknown) =>
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("project-profile", value);
    expect(validateProfile({ ...profile, unexpected: true }).valid).toBe(false);
    expect(validateProfile({ ...profile, profile_id: "turbo" }).valid).toBe(false);
    expect(validateProfile({ ...profile, revision: 0 }).valid).toBe(false);
    expect(validateProfile({ ...profile, revision: 1.5 }).valid).toBe(false);
    expect(validateProfile({ ...profile, policy_digest: "not-a-digest" }).valid).toBe(false);
    expect(validateProfile({ ...profile, protocol_version: "1.0.0" }).valid).toBe(false);
    const digestless: Record<string, unknown> = { ...profile };
    delete digestless["record_digest"];
    expect(validateProfile(digestless).valid).toBe(false);
    expect(verifyRecordEnvelope({ ...profile, revision: 2 })).toBe(false);

    const decision = goldenDecision() as unknown as Record<string, unknown>;
    const validateDecision = (value: unknown) =>
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("profile-decision", value);
    expect(validateDecision({ ...decision, decision_kind: "silent_default" }).valid).toBe(false);
    expect(validateDecision({ ...decision, reason: "" }).valid).toBe(false);
    expect(validateDecision({ ...decision, idempotency_key: "" }).valid).toBe(false);

    const binding = goldenCaptureBinding() as unknown as Record<string, unknown>;
    const validateBinding = (value: unknown) =>
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("model-provider-binding", value);
    expect(validateBinding({ ...binding, scope: "operation" }).valid).toBe(false);
    expect(
      validateBinding({
        ...binding,
        bindings: [{ ...(binding["bindings"] as object[])[0], failure_mode: "ignore" }],
      }).valid,
    ).toBe(false);
    expect(validateBinding({ ...binding, bindings: [] }).valid).toBe(false);
    // Prompt Governance: the binding must pin the resolved contract identity.
    const firstBinding = (binding["bindings"] as Record<string, unknown>[])[0]!;
    for (const field of [
      "prompt_contract_id",
      "prompt_contract_version",
      "prompt_contract_digest",
      "output_schema_digest",
    ]) {
      const incomplete = { ...firstBinding };
      delete incomplete[field];
      expect(validateBinding({ ...binding, bindings: [incomplete] }).valid, field).toBe(false);
    }
    expect(
      validateBinding({
        ...binding,
        bindings: [{ ...firstBinding, prompt_contract_digest: "not-a-digest" }],
      }).valid,
    ).toBe(false);
  });

  it("produces identical ids and digests for canonically equal input in any order", () => {
    const reordered = createProfileRecommendationRecord({
      project_id: PROJECT_ID,
      iteration_id: ITERATION_ID,
      current_profile_id: "lite",
      triggered: ["cross_component_change", "public_api_change"],
      risk_object_digest: DIGEST_B,
      requirement_digest: DIGEST_C,
      scope_digest: DIGEST_D,
      policy_digest: DIGEST_A,
      rationale: "本次变更触及公共 API 并跨多个组件，建议至少 Standard。",
      scope_reduction_hint: "可将公共 API 变更拆分为独立迭代以降低档位。",
    });
    expect(reordered).toEqual(goldenRecommendation());

    const binding = goldenCaptureBinding();
    const reorderedBinding = createCaptureModelProviderBindingRecord({
      project_id: PROJECT_ID,
      profile_decision_id: "profile-decision_01K1ABCDEFGHIJKLMNO",
      profile_decision_digest: DIGEST_E,
      policy_digest: DIGEST_A,
      config_digest: DIGEST_F,
      baseline_digest: DIGEST_B,
      bindings: [...binding.bindings].reverse(),
    });
    expect(reorderedBinding).toEqual(binding);
  });

  it("matches the committed golden fixtures byte for byte", () => {
    expect(goldenProjectProfile()).toEqual(readGolden("project-profile.json"));
    expect(goldenRecommendation()).toEqual(readGolden("profile-recommendation.json"));
    expect(goldenDecision()).toEqual(readGolden("profile-decision.json"));
    expect(goldenCaptureBinding()).toEqual(readGolden("model-provider-binding.json"));
  });
});

describe("capture binding prompt contract compilation", () => {
  function expectBindingError(
    configs: readonly Parameters<
      typeof compileCaptureModelProviderBindings
    >[0]["configs"][number][],
    kind: string,
  ): void {
    try {
      compileCaptureModelProviderBindings({
        prompt_contract_resolver: createCapturePromptContractRegistry(),
        configs,
      });
      expect.unreachable(`expected binding compile failure ${kind}`);
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileBindingError);
      expect((error as ProfileBindingError).kind, kind).toBe(kind);
    }
  }

  it("derives contract id/version/digest and output schema digest from the registry", () => {
    const [discovery] = goldenCaptureBindings();
    expect(discovery).toMatchObject({
      slot_id: "grounded_synthesis",
      purpose: "project_discovery",
      prompt_version: "project-discovery.v1",
      prompt_contract_id: PROJECT_DISCOVERY_PROMPT_CONTRACT.contract_id,
      prompt_contract_version: PROJECT_DISCOVERY_PROMPT_CONTRACT.version,
      prompt_contract_digest: PROJECT_DISCOVERY_PROMPT_CONTRACT.contract_digest,
      output_schema_digest: PROJECT_DISCOVERY_PROMPT_CONTRACT.output_schema_digest,
    });
  });

  it("rejects hand-supplied contract digests fail-closed", () => {
    expectBindingError(
      [
        {
          slot_id: "grounded_synthesis",
          purpose: "project_discovery",
          required: true,
          provider_identity: "provider_anthropic",
          config_digest: DIGEST_C,
          prompt_version: "project-discovery.v1",
          schema_version: "project-discovery-result.v1",
          budget_profile: "capture-standard",
          failure_mode: "block",
          prompt_contract_digest: "0".repeat(64),
        } as never,
      ],
      "prompt_contract_digest_mismatch",
    );
  });

  it("rejects unknown prompt versions instead of guessing the nearest contract", () => {
    expectBindingError(
      [
        {
          slot_id: "grounded_synthesis",
          purpose: "project_discovery",
          required: true,
          provider_identity: "provider_anthropic",
          config_digest: DIGEST_C,
          prompt_version: "project-discovery.v404",
          schema_version: "project-discovery-result.v1",
          budget_profile: "capture-standard",
          failure_mode: "block",
        },
      ],
      "prompt_contract_version_mismatch",
    );
  });

  it("rejects operation-scope slots in the capture compile path", () => {
    expectBindingError(
      [
        {
          slot_id: "plan_proposal",
          required: true,
          provider_identity: "provider_anthropic",
          config_digest: DIGEST_C,
          prompt_version: "plan_proposal.v1",
          schema_version: "plan-proposal-result.v1",
          budget_profile: "plan-standard",
          failure_mode: "block",
        } as never,
      ],
      "non_capture_scope_binding",
    );
  });
});
