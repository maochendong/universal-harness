import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  appendProfileDecisionRecord,
  appendProjectProfileRecord,
  contentDigest,
  createProfileDecisionRecord,
  createProjectProfileRecord,
  readManagedManifest,
} from "@universal-harness-internal/core";
import {
  JEV_IMPACT_PROMPT_CONTRACT,
  RELATION_RULE_REGISTRY,
} from "@universal-harness-internal/graph";
import { createNewProject, readModelInvocationRecords } from "@universal-harness-internal/runtime";

import { createProjectCapabilityPlanCompiler } from "../src/capability-plan-compiler.js";
import { createManagedPipelinePorts } from "../src/managed-pipeline-ports.js";
import type { ProjectRuntimeConfigV3 } from "../src/project-runtime-config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function bootstrap() {
  const parentDirectory = realpathSync(mkdtempSync(join(tmpdir(), "harness-jev-binding-")));
  roots.push(parentDirectory);
  let sequence = 0;
  const now = "2026-09-28T00:00:00Z";
  const result = await createNewProject(
    { parentDirectory, name: "jev-binding", intent: "Change report format" },
    { vcs: createGitVcsAdapter(), now: () => now, newId: (kind) => `${kind}_${++sequence}` },
  );
  if (!result.ok) throw new Error(result.error.message);
  const projectRoot = result.value.projectRoot;
  const project_id = `project_${readManagedManifest(projectRoot).name}`;
  appendProjectProfileRecord(
    projectRoot,
    createProjectProfileRecord({
      project_id,
      revision: 1,
      profile_id: "standard",
      policy_digest: "0".repeat(64),
      actor: "human:tester",
      effective_from: now,
    }),
  );
  appendProfileDecisionRecord(
    projectRoot,
    createProfileDecisionRecord({
      decision_kind: "project_profile_change",
      project_id,
      actor: "human:tester",
      idempotency_key: `profile:${project_id}`,
      current_profile_id: "standard",
      decided_profile_id: "standard",
      policy_digest: "0".repeat(64),
      decided_at: now,
    }),
  );
  return projectRoot;
}

function node(id: string, statement: string) {
  const value = {
    protocol_version: "1.1.0",
    record_kind: "node",
    id,
    type: "Requirement",
    revision: 1,
    status: "accepted",
    source: "workflow",
    confidence: 1,
    provenance: { iteration_id: "iteration_01", actor: "test", timestamp: "2026-09-28T00:00:00Z" },
    extensions: { "harness.requirements": { statement } },
  } as const;
  return { ...value, digest: contentDigest(value) };
}

describe("project capability provider contract binding", () => {
  it("binds the selected Jev contract and schema to the exact real pipeline invocation while preserving other slots", async () => {
    const projectRoot = await bootstrap();
    const runtimeConfig: ProjectRuntimeConfigV3 = {
      runtime_config_version: 3,
      gates: [],
      judge_gates: [],
      model_providers: [
        {
          provider_ref: "deepseek",
          model: "deepseek-v4-flash",
          slots: [],
          is_default: true,
          timeout_ms: 60000,
        },
        {
          provider_ref: "typesafe",
          model: "jev-1.13.0",
          slots: ["impact_advisory"],
          is_default: false,
          timeout_ms: 30000,
        },
      ],
    };
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            requirement_consumer: {
              type: "choice",
              choice: "affected",
              probabilities: { affected: 0.91, unrelated: 0.04, insufficient: 0.05 },
              confidence: 0.86,
            },
          },
          usage: { input_tokens: 300, output_tokens: 20 },
        }),
      );
    });
    const deps = {
      projectRoot,
      runtimeConfig,
      environment: { TYPESAFE_API_KEY: "fake", DEEPSEEK_API_KEY: "fake-other" },
      fetch: fetchMock,
    };
    const compile = createProjectCapabilityPlanCompiler(deps);
    const plan = compile({
      operation_id: "operation_01",
      stage: "initial",
      requirement_digest: "a".repeat(64),
      risk_digest: "b".repeat(64),
      policy_digest: "0".repeat(64),
      baseline_digest: "c".repeat(64),
    });
    const legacyCompile = createProjectCapabilityPlanCompiler({
      ...deps,
      runtimeConfig: {
        ...runtimeConfig,
        model_providers: runtimeConfig.model_providers!.filter(
          (entry) => entry.provider_ref !== "typesafe",
        ),
      },
    });
    const legacyPlan = legacyCompile({
      operation_id: "operation_01",
      stage: "initial",
      requirement_digest: "a".repeat(64),
      risk_digest: "b".repeat(64),
      policy_digest: "0".repeat(64),
      baseline_digest: "c".repeat(64),
    });
    expect(
      legacyPlan.model_provider_bindings.find((entry) => entry.slot_id === "impact_advisory"),
    ).toMatchObject({
      provider_identity: "provider_deepseek",
      prompt_version: "impact_advisory.v1",
      schema_version: "impact-advisory.v1",
    });
    expect(
      plan.model_provider_bindings.filter((entry) => entry.slot_id !== "impact_advisory"),
    ).toEqual(
      legacyPlan.model_provider_bindings.filter((entry) => entry.slot_id !== "impact_advisory"),
    );
    const binding = plan.model_provider_bindings.find(
      (entry) => entry.slot_id === "impact_advisory",
    );
    expect(binding).toMatchObject({
      prompt_version: "impact_advisory.jev.v1",
      schema_version: "jev-impact-judgments.v1",
      prompt_contract_id: JEV_IMPACT_PROMPT_CONTRACT.contract_id,
      prompt_contract_digest: JEV_IMPACT_PROMPT_CONTRACT.contract_digest,
      output_schema_digest: JEV_IMPACT_PROMPT_CONTRACT.output_schema_digest,
      provider_identity: "provider_typesafe",
    });
    expect(
      plan.model_provider_bindings
        .filter((entry) => entry.slot_id !== "impact_advisory")
        .every((entry) => entry.provider_identity === "provider_deepseek"),
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const ports = createManagedPipelinePorts({ ...deps, profile_id: "standard" });
    const seed = node("requirement_seed", "Change export format to JSON");
    const candidate = node("requirement_consumer", "Consume CSV exports");
    const result = await ports.impactAdvisory!.advise({
      workflow_operation_id: "operation_01",
      iteration_id: "iteration_01",
      run_id: "run_01",
      conversation_id: "conversation_01",
      impact_set_digest: "a".repeat(64),
      deterministic_entries: [
        {
          node_id: seed.id,
          node_type: seed.type,
          classification: "must-change",
          risk: "medium",
          confidence: 1,
          path: [],
          reason: "seed",
          seed_id: "seed_01",
        },
      ],
      nodes: [seed, candidate],
      requirement_digests: { [seed.id]: seed.digest },
      rule_registry_version: RELATION_RULE_REGISTRY.version,
      rule_registry_digest: RELATION_RULE_REGISTRY.digest,
    });
    expect(result).toMatchObject({
      status: "proposed",
      additions: [{ node_id: candidate.id, classification: "inspect" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readModelInvocationRecords(projectRoot).at(-1)).toMatchObject({
      state: "consumed",
      provider_identity: binding!.provider_identity,
      config_digest: binding!.config_digest,
      prompt_contract_id: binding!.prompt_contract_id,
      prompt_contract_version: binding!.prompt_contract_version,
      prompt_contract_digest: binding!.prompt_contract_digest,
      output_schema_digest: binding!.output_schema_digest,
      output_schema_id: "jev-impact-judgments",
    });
  });
});
