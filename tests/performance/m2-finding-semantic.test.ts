import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { LocalSymbolSemanticSeedProvider } from "../../packages/graph/src/index.js";
import type { SemanticIndexInput } from "../../packages/plugin-sdk/src/index.js";
import { projectFindingGroups } from "../../packages/runtime/src/index.js";

import { loadM2Dataset, measure, recordBaseline, summarizeSamples } from "./helpers.js";

const FINDING_GROUP_THRESHOLD_MS = 500;
const SEMANTIC_TOP_K_THRESHOLD_MS = 2_000;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M2 Finding and semantic performance", { timeout: 300_000 }, () => {
  it("groups 1,000 open Findings in under 500 ms with a stable projection", () => {
    const findings = loadM2Dataset().findings;
    const reference = projectFindingGroups(findings);
    expect(reference).toHaveLength(20);
    expect(reference.reduce((sum, group) => sum + group.member_count, 0)).toBe(1_000);

    const samples: number[] = [];
    for (let run = 0; run < 25; run += 1) {
      const timed = measure(() => projectFindingGroups(findings));
      expect(timed.result).toEqual(reference);
      samples.push(timed.elapsedMs);
    }
    const timing = summarizeSamples(samples);
    expect(timing.p95_ms).toBeLessThan(FINDING_GROUP_THRESHOLD_MS);
    recordBaseline("m2-finding-groups", {
      metric: "m2_finding_groups",
      operation_scale: { findings: 1_000, groups: 20 },
      timing,
    });
  });

  it("returns deterministic semantic top-K from a 10,000-node index in under two seconds", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-m2-semantic-perf-"));
    roots.push(root);
    const documents = Array.from({ length: 10_000 }, (_, index) => ({
      node_id: `code_semantic-${String(index).padStart(5, "0")}`,
      node_type: "CodeArtifact",
      revision: 1,
      locator: `repo://repository_perf/src/domain-${String(index % 100).padStart(3, "0")}/SharedService${String(index)}.ts`,
      source_digest: String(index).padStart(64, "0").slice(-64),
      blob_digest: `blob-${String(index).padStart(5, "0")}`,
      content: `export class SharedService${String(index)} { loadSharedProfile() {} }`,
    }));
    const input: SemanticIndexInput = {
      protocol_version: 1,
      project_id: "project_perf",
      git_commit: "a".repeat(40),
      graph_source_digest: "b".repeat(64),
      extractor_version: "symbol-v1",
      config_digest: "c".repeat(64),
      documents,
    };
    const provider = new LocalSymbolSemanticSeedProvider(root);
    const descriptor = await provider.buildIndex(input);
    expect(descriptor.entry_count).toBe(10_000);

    const samples: number[] = [];
    let reference: Awaited<ReturnType<typeof provider.suggest>> | undefined;
    for (let run = 0; run < 10; run += 1) {
      const started = performance.now();
      const suggestions = await provider.suggest({
        descriptor,
        source_node_ids: ["code_semantic-00000"],
        threshold_millionths: 1,
        top_k: 10,
      });
      samples.push(performance.now() - started);
      expect(suggestions).toHaveLength(10);
      if (reference === undefined) reference = suggestions;
      else expect(suggestions).toEqual(reference);
    }
    const timing = summarizeSamples(samples);
    expect(timing.p95_ms).toBeLessThan(SEMANTIC_TOP_K_THRESHOLD_MS);
    recordBaseline("m2-semantic-top-k", {
      metric: "m2_semantic_top_k",
      operation_scale: { indexed_nodes: 10_000, top_k: 10 },
      timing,
    });
  });
});
