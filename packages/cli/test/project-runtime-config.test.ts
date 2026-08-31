import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runGate } from "@universal-harness-internal/runtime";
import { createNewProject, runGateSuite } from "@universal-harness-internal/runtime";
import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  LedgerRepository,
  canonicalizeJson,
  contentDigest,
  createTrustedProviderRegistry,
  harnessRootFor,
  readCommittedOperations,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";

import {
  createConfiguredAgentExecutor,
  createConfiguredGateSuite,
  readProjectRuntimeConfig,
} from "../src/index.js";
import { fixtureEnvelope } from "../../../tests/helpers/agent-profiles.js";

const roots: string[] = [];

function judgeRegistry() {
  return createTrustedProviderRegistry([
    {
      provider_ref: "deepseek",
      provider_identity: "provider_deepseek",
      endpoint: "https://judge.example.com/v1/chat/completions",
      api_key_env: "JUDGE_KEY",
      env_allowlist: ["JUDGE_KEY"],
      allowed_consumers: ["llm_judge"],
    },
  ]);
}

function projectWithConfig(config: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-project-runtime-")));
  roots.push(root);
  mkdirSync(join(root, ".harness"));
  writeFileSync(join(root, ".harness", "runtime.json"), JSON.stringify(config), "utf8");
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("project runtime configuration", () => {
  it("commits reference-only v3 with zero network bindings for every new managed project", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "harness-project-runtime-v2-")));
    roots.push(parent);
    const created = await createNewProject(
      { parentDirectory: parent, name: "runtime-v2", intent: "start without network gates" },
      { vcs: createGitVcsAdapter() },
    );
    if (!created.ok) throw new Error(created.error.message);

    expect(readProjectRuntimeConfig(created.value.projectRoot)).toEqual({
      runtime_config_version: 3,
      gates: [],
      judge_gates: [],
      model_providers: [],
    });
    expect(
      execFileSync("git", ["show", "HEAD:.harness/runtime.json"], {
        cwd: created.value.projectRoot,
        encoding: "utf8",
      }),
    ).toBe('{"gates":[],"runtime_config_version":3}\n');
  });

  it("reads v3 provider references and rejects repository-owned trust fields", () => {
    const root = projectWithConfig({
      runtime_config_version: 3,
      gates: [],
      model_providers: [
        {
          provider_ref: "deepseek",
          model: "deepseek-v4-flash",
          slots: ["prd_proposal"],
          is_default: true,
          timeout_ms: 60_000,
        },
      ],
      judge_gates: [
        {
          gate_id: "gate_llm_review",
          name: "LLM review",
          subject_id: "test_llm_review",
          requested_mandatory: true,
          provider_ref: "deepseek",
          model: "deepseek-v4-flash",
          prompt_version: "judge.v1",
          timeout_ms: 60_000,
        },
      ],
    });

    expect(readProjectRuntimeConfig(root)).toMatchObject({
      runtime_config_version: 3,
      model_providers: [{ provider_ref: "deepseek", is_default: true }],
      judge_gates: [{ provider_ref: "deepseek" }],
    });

    for (const forbidden of ["endpoint", "api_key_env", "env_allowlist", "allow_loopback_http"]) {
      const poisoned = projectWithConfig({
        runtime_config_version: 3,
        gates: [],
        model_providers: [
          {
            provider_ref: "deepseek",
            model: "deepseek-v4-flash",
            slots: [],
            is_default: true,
            timeout_ms: 60_000,
            [forbidden]: forbidden === "env_allowlist" ? ["STOLEN_SECRET"] : "STOLEN_SECRET",
          },
        ],
      });
      expect(() => readProjectRuntimeConfig(poisoned)).toThrowError(
        new RegExp(`unknown field ${forbidden}`, "u"),
      );
    }
  });

  it("marks v1/v2 inline provider configurations as compatibility-only", () => {
    const v1 = readProjectRuntimeConfig(
      projectWithConfig({ runtime_config_version: 1, gates: [] }),
    );
    const v2 = readProjectRuntimeConfig(
      projectWithConfig({ runtime_config_version: 2, gates: [] }),
    );

    expect(v1.compatibility).toEqual({
      deprecated: true,
      code: "legacy_runtime_config_v1",
    });
    expect(v2.compatibility).toEqual({
      deprecated: true,
      code: "legacy_runtime_config_v2",
    });
  });

  it("reads v2 Judge gates while v1 remains a zero-Judge configuration", () => {
    const v1 = projectWithConfig({ runtime_config_version: 1, gates: [] });
    expect(readProjectRuntimeConfig(v1)).toEqual({ runtime_config_version: 1, gates: [] });

    const v2 = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      judge_gates: [
        {
          gate_id: "gate_semantic_review",
          name: "Semantic code review",
          subject_id: "test_semantic_review",
          requested_mandatory: true,
          endpoint: "https://judge.example.com/v1/chat/completions",
          model: "reviewer-v1",
          prompt_version: "2026-08-16",
          api_key_env: "JUDGE_API_KEY",
          env_allowlist: ["JUDGE_API_KEY"],
          timeout_ms: 30000,
          seed: 42,
        },
      ],
    });
    expect(readProjectRuntimeConfig(v2)).toEqual({
      runtime_config_version: 2,
      gates: [],
      judge_gates: [
        {
          gate_id: "gate_semantic_review",
          name: "Semantic code review",
          subject_id: "test_semantic_review",
          requested_mandatory: true,
          endpoint: "https://judge.example.com/v1/chat/completions",
          model: "reviewer-v1",
          prompt_version: "2026-08-16",
          api_key_env: "JUDGE_API_KEY",
          env_allowlist: ["JUDGE_API_KEY"],
          timeout_ms: 30000,
          seed: 42,
        },
      ],
    });
  });

  it.each([
    [
      "insecure endpoint",
      {
        endpoint: "http://judge.example.com/v1/chat/completions",
        env_allowlist: ["JUDGE_API_KEY"],
      },
    ],
    [
      "private endpoint",
      { endpoint: "https://169.254.169.254/latest", env_allowlist: ["JUDGE_API_KEY"] },
    ],
    [
      "secret outside allowlist",
      { endpoint: "https://judge.example.com/v1/chat/completions", env_allowlist: [] },
    ],
  ])("rejects Judge %s", (_name, override) => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      judge_gates: [
        {
          gate_id: "gate_semantic_review",
          name: "Semantic code review",
          subject_id: "test_semantic_review",
          requested_mandatory: false,
          model: "reviewer-v1",
          prompt_version: "2026-08-16",
          api_key_env: "JUDGE_API_KEY",
          timeout_ms: 30000,
          ...override,
        },
      ],
    });
    expect(() => readProjectRuntimeConfig(root)).toThrow(/judge_gates/u);
  });

  it("loads deterministic Agent scope and project gate commands", () => {
    const root = projectWithConfig({
      runtime_config_version: 1,
      agent: {
        provider: "dsh",
        expected_version: "0.1.0-rc.6",
        allowed_read_paths: ["docs", "src"],
        proposed_write_paths: ["scripts", "src"],
      },
      gates: [
        {
          gate_id: "gate_atlas_maven_test",
          name: "Atlas Maven tests",
          mandatory: true,
          subject_id: "test_atlas_maven",
          executable: "scripts/harness/maven-test",
          args: [],
          timeout_ms: 120000,
        },
      ],
    });

    expect(readProjectRuntimeConfig(root)).toEqual({
      runtime_config_version: 1,
      agent: {
        provider: "dsh",
        expected_version: "0.1.0-rc.6",
        executable: "npx",
        launcher_args: ["--no-install", "@deepseek-ai/dsh"],
        env_allowlist: ["DEEPSEEK_API_KEY", "DSH_HOME", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"],
        allowed_read_paths: ["docs", "src"],
        proposed_write_paths: ["scripts", "src"],
      },
      gates: [
        {
          gate_id: "gate_atlas_maven_test",
          name: "Atlas Maven tests",
          mandatory: true,
          subject_id: "test_atlas_maven",
          executable: "scripts/harness/maven-test",
          args: [],
          env_allowlist: ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"],
          timeout_ms: 120000,
        },
      ],
    });
  });

  it("executes a configured project gate through the Tool Registry", async () => {
    const root = projectWithConfig({
      runtime_config_version: 1,
      gates: [
        {
          gate_id: "gate_atlas_maven_test",
          name: "Atlas Maven tests",
          mandatory: true,
          subject_id: "test_atlas_maven",
          executable: "scripts/harness/maven-test",
          args: ["--batch"],
          timeout_ms: 120000,
        },
      ],
    });
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    let judgeCalls = 0;
    const suite = createConfiguredGateSuite(root, readProjectRuntimeConfig(root), {
      spawnProcess: (executable, options) => {
        calls.push({ executable, args: options.args });
        return Promise.resolve({
          exit_code: 0,
          signal: null,
          stdout: "Tests run: 102, Failures: 0\nBUILD SUCCESS\n",
          stderr: "",
          timed_out: false,
          output_truncated: false,
          aborted: false,
          duration_ms: 50,
        });
      },
      judgeTransport: {
        fetch: () => {
          judgeCalls += 1;
          return Promise.reject(new Error("v1 must never call Judge"));
        },
      },
    });
    const gate = suite.gates.find((candidate) => candidate.gate_id === "gate_atlas_maven_test");
    if (gate === undefined) throw new Error("configured gate not found");

    const outcome = await runGate(suite.registry, gate, { intentId: "intent_gate_test" });

    expect(calls).toEqual([
      { executable: join(root, "scripts", "harness", "maven-test"), args: ["--batch"] },
    ]);
    expect(outcome).toMatchObject({ passed: true, exit_code: 0, layer: "project" });
    expect(outcome.artifact_hashes[".harness/raw-traces/gates/gate_atlas_maven_test.log"]).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(judgeCalls).toBe(0);
    expect(
      existsSync(join(root, ".harness", "raw-traces", "gates", "gate_atlas_maven_test.log")),
    ).toBe(true);
  });

  it("runs a configured Judge as advisory without approved Policy and records secret-free Evidence", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "harness-project-judge-")));
    roots.push(parent);
    const created = await createNewProject(
      { parentDirectory: parent, name: "judge-project", intent: "review this change" },
      { vcs: createGitVcsAdapter() },
    );
    if (!created.ok) throw new Error(created.error.message);
    const root = created.value.projectRoot;
    const config = {
      runtime_config_version: 3 as const,
      gates: [],
      judge_gates: [
        {
          gate_id: "gate_semantic_review",
          name: "Semantic review",
          subject_id: "test_semantic_review",
          requested_mandatory: true,
          provider_ref: "deepseek",
          model: "reviewer-v1",
          prompt_version: "v1",
          timeout_ms: 1000,
        },
      ],
    };
    const suite = createConfiguredGateSuite(root, config, {
      providerRegistry: judgeRegistry(),
      ambientEnvironment: { JUDGE_KEY: "secret-value" },
      reviewBundle: () => ({
        baseline_commit: "a".repeat(40),
        source_commit: "b".repeat(40),
        code_digest: "c".repeat(64),
        changed_paths: ["src/app.ts"],
        diff: "+export const value = 1;",
        acceptance_criteria: ["value is reviewed"],
        related_records: [],
        deterministic_gates: [],
        line_counts: { "src/app.ts": 1 },
      }),
      judgeTransport: {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        verdict: "warn",
                        confidence: 0.8,
                        reasons: [{ code: "review", message: "inspect value" }],
                      }),
                    },
                  },
                ],
              }),
              { status: 200 },
            ),
          ),
      },
    });
    const judge = suite.gates.find((gate) => gate.gate_id === "gate_semantic_review");
    if (judge === undefined) throw new Error("Judge gate missing");
    expect(judge.mandatory).toBe(false);

    const outcome = await runGateSuite(suite.registry, {
      iterationId: created.value.iterationId,
      repositoryId: "repository_judge",
      gates: [judge],
      bindings: {
        artifact_digests: ["a".repeat(64)],
        code_digests: ["b".repeat(64)],
        evaluation_case_digests: [],
        policy_digest: "c".repeat(64),
      },
      clock: () => "2026-08-16T00:00:00.000Z",
    });
    expect(outcome.completed_allowed).toBe(true);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.extensions?.["harness.finding"]).toMatchObject({
      blocking: false,
    });
    expect(outcome.results[0]?.evidence.extensions?.["harness.llm-judge"]).toMatchObject({
      model: "reviewer-v1",
      trusted_provider_policy_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      requested_mandatory: true,
      effective_mandatory: false,
      policy_diagnostics: ["blocking_policy_missing"],
      normalized_response: { verdict: "warn" },
    });
    expect(JSON.stringify(outcome)).not.toContain("secret-value");
  });

  it("blocks on a failing Judge only after a digest-bound Policy approval", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "harness-project-judge-policy-")));
    roots.push(parent);
    const created = await createNewProject(
      { parentDirectory: parent, name: "judge-policy", intent: "govern blocking review" },
      { vcs: createGitVcsAdapter() },
    );
    if (!created.ok) throw new Error(created.error.message);
    const root = created.value.projectRoot;
    const timestamp = "2026-08-16T00:00:00.000Z";
    const policyContent = {
      protocol_version: "1.0.0",
      record_kind: "node" as const,
      id: "policy_judge-review",
      type: "Policy" as const,
      revision: 1,
      status: "accepted" as const,
      source: "human" as const,
      provenance: {
        iteration_id: created.value.iterationId,
        actor: "human:policy-owner",
        timestamp,
      },
      confidence: 1,
      policy_fields: [
        {
          path: "gates.gate_semantic-review.llm_judge_blocking",
          merge_operator: "project_default" as const,
          value: true,
        },
      ],
    };
    const policy = { ...policyContent, digest: contentDigest(policyContent) } as NodeRecord;
    const approvalContent = {
      protocol_version: "1.0.0",
      record_kind: "node" as const,
      id: "approval_judge-review",
      type: "Approval" as const,
      revision: 1,
      status: "accepted" as const,
      source: "human" as const,
      provenance: {
        iteration_id: created.value.iterationId,
        actor: "human:policy-approver",
        timestamp,
      },
      confidence: 1,
      extensions: { "harness.approval": { object_digest: policy.digest } },
    };
    const approval = {
      ...approvalContent,
      digest: contentDigest(approvalContent),
    } as NodeRecord;
    const edgeContent = {
      protocol_version: "1.0.0",
      record_kind: "edge" as const,
      id: "edge_judge-approval-policy",
      type: "APPROVES" as const,
      source_id: approval.id,
      target_id: policy.id,
      status: "accepted" as const,
      source: "human" as const,
      provenance: {
        iteration_id: created.value.iterationId,
        actor: "human:policy-approver",
        timestamp,
      },
      confidence: 1,
    };
    const approvalEdge = {
      ...edgeContent,
      digest: contentDigest(edgeContent),
    } as EdgeRecord;
    const last = readCommittedOperations(harnessRootFor(root)).at(-1);
    if (last === undefined) throw new Error("bootstrap operation missing");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    await new LedgerRepository({ projectRoot: root, readBaseline: () => head }).commit({
      ledger_operation_id: "ledger_judge-policy",
      workflow_operation_id: last.manifest.workflow_operation_id,
      attempt_id: last.manifest.attempt_id,
      expected_baseline: head,
      artifacts: [policy, approval].map((node) => ({
        path: `artifacts/policies/${node.id}/1.json`,
        content: `${canonicalizeJson(node)}\n`,
      })),
      edges: [approvalEdge],
      events: [],
    });

    const suite = createConfiguredGateSuite(
      root,
      {
        runtime_config_version: 2,
        gates: [],
        judge_gates: [
          {
            gate_id: "gate_semantic-review",
            name: "Semantic review",
            subject_id: "test_semantic-review",
            requested_mandatory: true,
            endpoint: "https://judge.example.com/v1/chat/completions",
            model: "reviewer-v1",
            prompt_version: "v1",
            api_key_env: "JUDGE_KEY",
            env_allowlist: ["JUDGE_KEY"],
            timeout_ms: 1_000,
          },
        ],
      },
      {
        providerRegistry: judgeRegistry(),
        ambientEnvironment: { JUDGE_KEY: "secret-value" },
        reviewBundle: () => ({
          baseline_commit: head,
          source_commit: head,
          code_digest: "c".repeat(64),
          changed_paths: ["src/app.ts"],
          diff: "+export const unsafe = true;",
          acceptance_criteria: ["unsafe code is rejected"],
          related_records: [],
          deterministic_gates: [],
          line_counts: { "src/app.ts": 1 },
        }),
        judgeTransport: {
          fetch: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          verdict: "fail",
                          confidence: 1,
                          reasons: [
                            {
                              code: "unsafe",
                              message: "unsafe change",
                              path: "src/app.ts",
                              line: 1,
                            },
                          ],
                        }),
                      },
                    },
                  ],
                }),
                { status: 200 },
              ),
            ),
        },
      },
    );
    const judge = suite.gates.find((gate) => gate.gate_id === "gate_semantic-review");
    if (judge === undefined) throw new Error("Judge gate missing");
    expect(judge.mandatory).toBe(true);

    const outcome = await runGateSuite(suite.registry, {
      iterationId: created.value.iterationId,
      repositoryId: created.value.repositoryId,
      gates: [judge],
      bindings: {
        artifact_digests: [policy.digest],
        code_digests: ["c".repeat(64)],
        evaluation_case_digests: [],
        policy_digest: policy.digest,
      },
      clock: () => timestamp,
    });
    expect(outcome.completed_allowed).toBe(false);
    expect(outcome.findings[0]?.extensions?.["harness.finding"]).toMatchObject({
      blocking: true,
    });
    expect(outcome.results[0]?.evidence.extensions?.["harness.llm-judge"]).toMatchObject({
      effective_mandatory: true,
      policy_digest: policy.digest,
      approval_id: approval.id,
      normalized_response: { verdict: "fail" },
    });
    expect(JSON.stringify(outcome)).not.toContain("secret-value");
  });

  it("selects dsh as the configured orchestration executor", async () => {
    const root = projectWithConfig({
      runtime_config_version: 1,
      agent: {
        provider: "dsh",
        expected_version: "0.1.0-rc.6",
        allowed_read_paths: ["docs", "src"],
        proposed_write_paths: ["src"],
      },
      gates: [],
    });
    const config = readProjectRuntimeConfig(root);
    if (config.agent === undefined) throw new Error("agent config missing");
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const configured = createConfiguredAgentExecutor(root, config.agent, {
      inspector: {
        inspect: () =>
          Promise.resolve({
            head: "0123456789abcdef0123456789abcdef01234567",
            changed_paths: [],
            digest: "a".repeat(64),
          }),
      },
      spawnProcess: (_executable, options) => {
        mutableCalls.push([...options.args]);
        return Promise.resolve({
          exit_code: 0,
          signal: null,
          stdout: options.args.at(-1) === "--version" ? "0.1.0-rc.6\n" : "done\n",
          stderr: "",
          timed_out: false,
          output_truncated: false,
          aborted: false,
          duration_ms: 1,
        });
      },
    });

    const result = await configured.execute(
      fixtureEnvelope({
        allowed_read_paths: configured.scope.allowed_read_paths,
        proposed_write_paths: configured.scope.proposed_write_paths,
      }),
    );

    expect(configured.name).toBe("agent-dsh");
    expect(configured.trajectoryVisibility).toBe("external-only");
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ outcome: "handoff", completion_claimed: true });
  });
});
