import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  contentDigest,
  createProjectContextBundleRecord,
  harnessRootFor,
} from "@universal-harness-internal/core";
import { readModelInvocationRecords } from "@universal-harness-internal/runtime";
import { RELATION_RULE_REGISTRY } from "@universal-harness-internal/graph";

import { createManagedPipelinePorts, readProjectRuntimeConfig } from "../src/index.js";

const roots: string[] = [];

const ALL_SLOTS = [
  "design_proposal",
  "design_review",
  "impact_advisory",
  "context_enrichment",
  "iteration_narrative",
] as const;

function providerEntry(slots: readonly string[]) {
  return {
    provider_id: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-pro",
    api_key_env: "DEEPSEEK_API_KEY",
    env_allowlist: ["DEEPSEEK_API_KEY"],
    timeout_ms: 60000,
    slots: [...slots],
  };
}

function projectWithConfig(config: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-pipeline-ports-")));
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

function portsFor(
  root: string,
  overrides: { readonly fetch?: typeof fetch } = {},
): ReturnType<typeof createManagedPipelinePorts> {
  return createManagedPipelinePorts({
    projectRoot: root,
    runtimeConfig: readProjectRuntimeConfig(root),
    profile_id: "standard",
    environment: { DEEPSEEK_API_KEY: "sk-test" },
    ...overrides,
  });
}

const IMPACT_SET_DIGEST = "a".repeat(64);

function fetchReturning(content: string, seen: { authorization?: string | null }): typeof fetch {
  return (_url, init) => {
    seen.authorization = new Headers(init?.headers).get("authorization");
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    );
  };
}

describe("createManagedPipelinePorts", () => {
  it("wires nothing when the project declares no model_providers", () => {
    const root = projectWithConfig({ runtime_config_version: 2, gates: [] });
    expect(portsFor(root)).toEqual({});
  });

  it("wires nothing for slots no declared provider covers", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(["prd_proposal"])],
    });
    expect(portsFor(root)).toEqual({});
  });

  it("wires exactly the covered slots", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(["design_proposal", "impact_advisory"])],
    });
    const ports = portsFor(root);
    expect(ports.design?.proposal).toBeDefined();
    expect(ports.design?.review).toBeUndefined();
    expect(ports.impactAdvisory).toBeDefined();
    expect(ports.contextEnrichment).toBeUndefined();
    expect(ports.iterationNarrative).toBeUndefined();
  });

  it("runs the impact advisory through the managed layer, authenticated from the environment", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(ALL_SLOTS)],
    });
    const seen: { authorization?: string | null } = {};
    const ports = portsFor(root, {
      fetch: fetchReturning(
        JSON.stringify({
          purpose: "impact_advisory",
          schema_version: "impact-advisory.v1",
          impact_set_digest: IMPACT_SET_DIGEST,
          additions: [],
          edge_candidates: [],
          risk_signals: [],
          missing_facts: [],
          questions: [],
        }),
        seen,
      ),
    });
    const result = await ports.impactAdvisory!.advise({
      workflow_operation_id: "operation_01K1ABC",
      iteration_id: "iteration_01K1ABC",
      impact_set_digest: IMPACT_SET_DIGEST,
      deterministic_entries: [],
      nodes: [],
      requirement_digests: {},
      rule_registry_version: RELATION_RULE_REGISTRY.version,
      rule_registry_digest: RELATION_RULE_REGISTRY.digest,
      conversation_id: "impact-advisory-conversation_01K1ABC",
      run_id: "impact-advisory-run_01K1ABC",
    });
    expect(seen.authorization).toBe("Bearer sk-test");
    expect(result.status).toBe("proposed");
    expect(readModelInvocationRecords(root).map((record) => record.state)).toEqual([
      "planned",
      "started",
      "completed",
      "validated",
      "consumed",
    ]);
  });

  it("maps a failing design proposal provider to a typed port failure", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(ALL_SLOTS)],
    });
    let attempts = 0;
    const fetchFake: typeof fetch = () => {
      attempts += 1;
      return Promise.resolve(new Response("boom", { status: 500 }));
    };
    const ports = portsFor(root, { fetch: fetchFake });
    const result = await ports.design!.proposal!.propose({
      workflow_operation_id: "operation_01K1DEF",
      iteration_id: "iteration_01K1DEF",
      requirement_baseline_digest: "c".repeat(64),
      impact_set_id: "impactset_01K1DEF",
      impact_set_digest: IMPACT_SET_DIGEST,
      policy_digest: "d".repeat(64),
      repository_baseline: "e".repeat(64),
      must_change_requirement_ids: [],
      requirement_impact_risks: {},
      criterion_test_pairs: [],
      sources: [],
      bundle_digest: "f".repeat(64),
      conversation_id: "design-proposal-conversation_01K1DEF",
      run_id: "design-proposal-run_01K1DEF",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("provider_unavailable");
    expect(attempts).toBe(3);
  });

  it("resolves snapshot bundle sources from the committed ledger artifacts", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(ALL_SLOTS)],
    });
    const snapshotContent = `${JSON.stringify({ record_kind: "snapshot", note: "committed" })}\n`;
    const snapshotDir = join(harnessRootFor(root), "artifacts", "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, "snapshot_01K1SNAP.json"), snapshotContent, "utf8");
    const bundle = createProjectContextBundleRecord({
      session_id: "iteration_01K1GHI",
      purpose: "context_enrichment",
      project_baseline_digest: "1".repeat(64),
      profile_digest: "2".repeat(64),
      policy_digest: "3".repeat(64),
      budget: {
        max_files: 1,
        max_bytes_per_source: 4096,
        max_total_bytes: 4096,
        max_summary_chars: 500,
      },
      sources: [
        {
          locator: "harness://snapshots/snapshot_01K1SNAP",
          source_kind: "graph",
          source_digest: contentDigest(snapshotContent),
          selection_reason: "the committed authoritative snapshot",
          classification: "internal_project",
          summary: "",
          truncated: false,
        },
      ],
      exclusions: [],
    });
    const ports = portsFor(root, {
      fetch: fetchReturning(
        JSON.stringify({
          purpose: "iteration_narrative",
          schema_version: "iteration-narrative.v1",
          bundle_digest: bundle.record_digest,
          outcomes: [],
          residual_risks: [],
          follow_ups: [],
        }),
        {},
      ),
    });
    const result = await ports.iterationNarrative!.synthesize({
      purpose: "iteration_narrative",
      schema_version: "iteration-narrative.v1",
      binding_digest: "4".repeat(64),
      conversation_id: "iteration-narrative-conversation_01K1GHI",
      run_id: "iteration-narrative-run_01K1GHI",
      bundle,
    });
    expect(result.status).toBe("completed");
  });

  it("fails closed when a bundle source resolves to no graph node", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(ALL_SLOTS)],
    });
    const bundle = createProjectContextBundleRecord({
      session_id: "iteration_01K1JKL",
      purpose: "context_enrichment",
      project_baseline_digest: "1".repeat(64),
      profile_digest: "2".repeat(64),
      policy_digest: "3".repeat(64),
      budget: {
        max_files: 1,
        max_bytes_per_source: 4096,
        max_total_bytes: 4096,
        max_summary_chars: 500,
      },
      sources: [
        {
          locator: "node://requirement_missing",
          source_kind: "graph",
          source_digest: "5".repeat(64),
          selection_reason: "missing node",
          classification: "internal_project",
          summary: "",
          truncated: false,
        },
      ],
      exclusions: [],
    });
    const ports = portsFor(root, { fetch: fetchReturning("{}", {}) });
    await expect(
      ports.contextEnrichment!.synthesize({
        purpose: "context_enrichment",
        schema_version: "context-enrichment.v1",
        binding_digest: "4".repeat(64),
        conversation_id: "context-enrichment-conversation_01K1JKL",
        run_id: "context-enrichment-run_01K1JKL",
        bundle,
      }),
    ).rejects.toThrowError();
  });
});
