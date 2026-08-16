import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SemanticIndexInput } from "@universal-harness-internal/plugin-sdk";

import { LocalSymbolSemanticSeedProvider } from "../../src/index.js";

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-semantic-"));
  roots.push(root);
  return root;
}

function input(overrides: Partial<SemanticIndexInput> = {}): SemanticIndexInput {
  return {
    protocol_version: 1,
    project_id: "project_01",
    git_commit: "a".repeat(40),
    graph_source_digest: "b".repeat(64),
    extractor_version: "symbol-v1",
    config_digest: "c".repeat(64),
    documents: [
      {
        node_id: "code_source",
        node_type: "CodeArtifact",
        revision: 1,
        locator: "repo://repository_01/src/UserService.ts",
        source_digest: "1".repeat(64),
        blob_digest: "a1",
        content: "export class UserService { loadUserProfile() {} }",
      },
      {
        node_id: "code_candidate_a",
        node_type: "CodeArtifact",
        revision: 2,
        locator: "repo://repository_01/test/UserService.test.ts",
        source_digest: "2".repeat(64),
        blob_digest: "a2",
        content: "describe UserService loadUserProfile",
      },
      {
        node_id: "code_candidate_b",
        node_type: "CodeArtifact",
        revision: 1,
        locator: "repo://repository_01/docs/UserService.md",
        source_digest: "3".repeat(64),
        blob_digest: "a3",
        content: "# User Service\nload user profile",
      },
      {
        node_id: "code_unrelated",
        node_type: "CodeArtifact",
        revision: 1,
        locator: "repo://repository_01/src/payments/Invoice.ts",
        source_digest: "4".repeat(64),
        blob_digest: "a4",
        content: "export class InvoiceCalculator {}",
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalSymbolSemanticSeedProvider", () => {
  it("builds byte-identical indexes and stable top-K suggestions after cache deletion", async () => {
    const root = projectRoot();
    const provider = new LocalSymbolSemanticSeedProvider(root);
    const first = await provider.buildIndex(input());
    const firstBytes = readFileSync(first.cache_path, "utf8");
    const firstSuggestions = await provider.suggest({
      descriptor: first,
      source_node_ids: ["code_source"],
      threshold_millionths: 350_000,
      top_k: 2,
    });
    rmSync(join(first.cache_path, ".."), { recursive: true, force: true });

    const second = await provider.buildIndex(input());
    const secondBytes = readFileSync(second.cache_path, "utf8");
    const secondSuggestions = await provider.suggest({
      descriptor: second,
      source_node_ids: ["code_source"],
      threshold_millionths: 350_000,
      top_k: 2,
    });

    expect(second).toEqual(first);
    expect(secondBytes).toBe(firstBytes);
    expect(secondSuggestions).toEqual(firstSuggestions);
    expect(firstSuggestions.map((entry) => entry.candidate_node_id)).toEqual([
      "code_candidate_a",
      "code_candidate_b",
    ]);
    expect(firstSuggestions.every((entry) => entry.score.millionths <= 990_000)).toBe(true);
  });

  it("invalidates the cache on Git, blob, graph, config or provider-version changes", async () => {
    const root = projectRoot();
    const base = await new LocalSymbolSemanticSeedProvider(root).buildIndex(input());
    const cases = [
      input({ git_commit: "d".repeat(40) }),
      input({ graph_source_digest: "e".repeat(64) }),
      input({ config_digest: "f".repeat(64) }),
      input({
        documents: input().documents.map((document, index) =>
          index === 0 ? { ...document, blob_digest: "changed" } : document,
        ),
      }),
    ];
    for (const changed of cases) {
      const descriptor = await new LocalSymbolSemanticSeedProvider(root).buildIndex(changed);
      expect(descriptor.input_digest).not.toBe(base.input_digest);
    }
    const versioned = await new LocalSymbolSemanticSeedProvider(root, {
      version: "2.0.0",
    }).buildIndex(input());
    expect(versioned.input_digest).not.toBe(base.input_digest);
  });

  it("rebuilds a corrupt cache and rejects stale descriptors", async () => {
    const root = projectRoot();
    const provider = new LocalSymbolSemanticSeedProvider(root);
    const descriptor = await provider.buildIndex(input());
    writeFileSync(descriptor.cache_path, "corrupt", "utf8");

    const rebuilt = await provider.buildIndex(input());
    expect(existsSync(rebuilt.cache_path)).toBe(true);
    expect(readFileSync(rebuilt.cache_path, "utf8")).not.toBe("corrupt");
    await expect(
      provider.suggest({
        descriptor: { ...rebuilt, index_digest: "0".repeat(64) },
        source_node_ids: ["code_source"],
        threshold_millionths: 1,
        top_k: 10,
      }),
    ).rejects.toThrow(/descriptor|digest/u);
  });
});
