import { afterEach, describe, it } from "vitest";

import { LocalSymbolSemanticSeedProvider } from "@universal-harness-internal/graph";
import type { SemanticIndexInput } from "@universal-harness-internal/plugin-sdk";

import {
  assertConformance,
  makeTempDir,
  removeTempDir,
  runConformanceSuite,
  semanticSeedProviderConformanceCases,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root);
});

describe("local symbol semantic seed provider conformance", () => {
  it("satisfies the shared semantic provider contract", async () => {
    const root = makeTempDir("harness-semantic-conformance-");
    roots.push(root);
    const input: SemanticIndexInput = {
      protocol_version: 1,
      project_id: "project_conformance",
      git_commit: "a".repeat(40),
      graph_source_digest: "b".repeat(64),
      extractor_version: "symbol-v1",
      config_digest: "c".repeat(64),
      documents: [
        {
          node_id: "code_source",
          node_type: "CodeArtifact",
          revision: 1,
          locator: "repo://repository_01/src/AccountService.ts",
          source_digest: "d".repeat(64),
          content: "export class AccountService { loadAccount() {} }",
        },
        {
          node_id: "test_candidate_a",
          node_type: "Test",
          revision: 1,
          locator: "repo://repository_01/test/AccountService.test.ts",
          source_digest: "e".repeat(64),
          content: "describe('AccountService loadAccount', () => {})",
        },
        {
          node_id: "doc_candidate_b",
          node_type: "CodeArtifact",
          revision: 1,
          locator: "repo://repository_01/docs/AccountService.md",
          source_digest: "f".repeat(64),
          content: "# Account Service\nLoad an account",
        },
      ],
    };
    const provider = new LocalSymbolSemanticSeedProvider(root);
    const report = await runConformanceSuite({
      plugin: provider.name,
      kind: "tool",
      cases: semanticSeedProviderConformanceCases(provider, input),
    });
    assertConformance(report);
  });
});
