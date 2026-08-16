import type {
  SemanticIndexInput,
  SemanticSeedProvider,
  SemanticSeedSuggestion,
} from "@universal-harness-internal/plugin-sdk";

import type { ConformanceCase } from "./runner.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function assertSuggestion(
  suggestion: SemanticSeedSuggestion,
  provider: SemanticSeedProvider,
  inputDigest: string,
  indexDigest: string,
): void {
  assert(
    suggestion.source_node_id !== suggestion.candidate_node_id,
    "provider suggested a self edge",
  );
  assert(
    suggestion.score.millionths > 0 && suggestion.score.millionths <= 990_000,
    "semantic score must stay in (0, 0.99]",
  );
  assert(suggestion.provider === provider.name, "suggestion provider name drifted");
  assert(suggestion.provider_version === provider.version, "suggestion provider version drifted");
  assert(suggestion.input_digest === inputDigest, "suggestion input digest drifted");
  assert(suggestion.index_digest === indexDigest, "suggestion index digest drifted");
}

/** Shared behavior contract for local or third-party semantic seed providers. */
export function semanticSeedProviderConformanceCases(
  provider: SemanticSeedProvider,
  input: SemanticIndexInput,
): ConformanceCase[] {
  return [
    {
      name: "semantic index descriptor is deterministic and version-bound",
      async run() {
        const first = await provider.buildIndex(input);
        const second = await provider.buildIndex(input);
        assert(stable(second) === stable(first), "repeated index builds changed the descriptor");
        assert(first.provider === provider.name, "descriptor provider name drifted");
        assert(first.provider_version === provider.version, "descriptor provider version drifted");
        assert(first.entry_count === input.documents.length, "descriptor entry count is wrong");
      },
    },
    {
      name: "semantic suggestions are deterministic, bounded and digest-bound",
      async run() {
        const descriptor = await provider.buildIndex(input);
        const request = {
          descriptor,
          source_node_ids: [input.documents[0]?.node_id ?? "node_missing"],
          threshold_millionths: 1,
          top_k: 10,
        } as const;
        const first = await provider.suggest(request);
        const second = await provider.suggest(request);
        assert(stable(second) === stable(first), "repeated suggestions changed order or content");
        const identities = new Set<string>();
        for (const suggestion of first) {
          assertSuggestion(suggestion, provider, descriptor.input_digest, descriptor.index_digest);
          const identity = `${suggestion.source_node_id}\u0000${suggestion.candidate_node_id}`;
          assert(!identities.has(identity), `provider returned duplicate suggestion ${identity}`);
          identities.add(identity);
        }
        const sorted = [...first].sort(
          (left, right) =>
            left.source_node_id.localeCompare(right.source_node_id) ||
            right.score.millionths - left.score.millionths ||
            left.candidate_node_id.localeCompare(right.candidate_node_id),
        );
        assert(stable(sorted) === stable(first), "suggestions violate score/id tie-break ordering");
      },
    },
  ];
}
