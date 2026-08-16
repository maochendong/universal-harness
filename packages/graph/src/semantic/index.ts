import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalizeJson, contentDigest } from "@universal-harness-internal/core";
import type {
  SemanticFeatureExplanation,
  SemanticIndexDescriptor,
  SemanticIndexInput,
  SemanticSeedProvider,
  SemanticSeedRequest,
  SemanticSeedSuggestion,
} from "@universal-harness-internal/plugin-sdk";

import { extractSemanticFeatures, type SemanticFeatures, weightedJaccard } from "./extractor.js";

interface SemanticIndexEntry {
  readonly node_id: string;
  readonly node_type: string;
  readonly revision: number;
  readonly features: SemanticFeatures;
}

interface SemanticIndexBase {
  readonly semantic_index_version: 1;
  readonly provider: string;
  readonly provider_version: string;
  readonly input_digest: string;
  readonly entries: readonly SemanticIndexEntry[];
}

interface SemanticIndexFile extends SemanticIndexBase {
  readonly index_digest: string;
}

const EXPLANATION_WEIGHTS = { symbols: 8, imports: 5, paths: 3, terms: 1 } as const;
const EXPLANATION_KINDS = {
  symbols: "symbol",
  imports: "import",
  paths: "path",
  terms: "term",
} as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertIndexInput(input: SemanticIndexInput): void {
  if (input.protocol_version !== 1)
    throw new Error("semantic input protocol version is unsupported");
  const identities = new Set<string>();
  for (const document of input.documents) {
    if (!Number.isInteger(document.revision) || document.revision < 1) {
      throw new Error(`semantic document ${document.node_id} has an invalid revision`);
    }
    const identity = `${document.node_id}\u0000${document.revision}`;
    if (identities.has(identity)) throw new Error(`duplicate semantic document ${identity}`);
    identities.add(identity);
  }
}

function inputBinding(
  provider: string,
  providerVersion: string,
  input: SemanticIndexInput,
): string {
  return contentDigest({ provider, provider_version: providerVersion, input });
}

function indexBase(
  provider: string,
  providerVersion: string,
  inputDigest: string,
  input: SemanticIndexInput,
): SemanticIndexBase {
  const entries = [...input.documents]
    .sort(
      (left, right) => compareText(left.node_id, right.node_id) || left.revision - right.revision,
    )
    .map((document) => ({
      node_id: document.node_id,
      node_type: document.node_type,
      revision: document.revision,
      features: extractSemanticFeatures({
        ...(document.locator === undefined ? {} : { locator: document.locator }),
        content: document.content,
      }),
    }));
  return {
    semantic_index_version: 1,
    provider,
    provider_version: providerVersion,
    input_digest: inputDigest,
    entries,
  };
}

function semanticIndexFile(base: SemanticIndexBase): SemanticIndexFile {
  return { ...base, index_digest: contentDigest(base) };
}

function readValidatedIndex(path: string): SemanticIndexFile {
  const value = JSON.parse(readFileSync(path, "utf8")) as SemanticIndexFile;
  const { index_digest: indexDigest, ...base } = value;
  if (value.semantic_index_version !== 1 || contentDigest(base) !== indexDigest) {
    throw new Error("semantic index digest is invalid");
  }
  return value;
}

function sharedExplanations(
  left: SemanticFeatures,
  right: SemanticFeatures,
): SemanticFeatureExplanation[] {
  const explanations: SemanticFeatureExplanation[] = [];
  for (const kind of Object.keys(EXPLANATION_WEIGHTS) as (keyof typeof EXPLANATION_WEIGHTS)[]) {
    const rightTokens = new Set(right[kind]);
    for (const token of left[kind]) {
      if (rightTokens.has(token)) {
        explanations.push({
          kind: EXPLANATION_KINDS[kind],
          token,
          weight: EXPLANATION_WEIGHTS[kind],
        });
      }
    }
  }
  return explanations.sort(
    (leftEntry, rightEntry) =>
      rightEntry.weight - leftEntry.weight ||
      compareText(leftEntry.kind, rightEntry.kind) ||
      compareText(leftEntry.token, rightEntry.token),
  );
}

export interface LocalSymbolSemanticSeedProviderOptions {
  readonly version?: string;
}

/** Deterministic, local-only semantic candidate provider. It has no Ledger write capability. */
export class LocalSymbolSemanticSeedProvider implements SemanticSeedProvider {
  readonly name = "local-symbol";
  readonly version: string;
  readonly #projectRoot: string;

  constructor(projectRoot: string, options: LocalSymbolSemanticSeedProviderOptions = {}) {
    this.#projectRoot = projectRoot;
    this.version = options.version ?? "1.0.0";
  }

  async buildIndex(input: SemanticIndexInput): Promise<SemanticIndexDescriptor> {
    assertIndexInput(input);
    const inputDigest = inputBinding(this.name, this.version, input);
    const base = indexBase(this.name, this.version, inputDigest, input);
    const expected = semanticIndexFile(base);
    const safeVersion = this.version.replace(/[^a-zA-Z0-9._-]/gu, "_");
    const path = join(
      this.#projectRoot,
      ".harness",
      "cache",
      "semantic",
      safeVersion,
      inputDigest,
      "index.json",
    );
    let index: SemanticIndexFile;
    try {
      const cached = readValidatedIndex(path);
      if (canonicalizeJson(cached) !== canonicalizeJson(expected)) {
        throw new Error("semantic cache descriptor does not match its input");
      }
      index = cached;
    } catch {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${canonicalizeJson(expected)}\n`, "utf8");
      renameSync(temporary, path);
      index = expected;
    }
    return {
      provider: this.name,
      provider_version: this.version,
      input_digest: inputDigest,
      index_digest: index.index_digest,
      entry_count: index.entries.length,
      cache_path: path,
    };
  }

  async suggest(request: SemanticSeedRequest): Promise<readonly SemanticSeedSuggestion[]> {
    if (
      request.descriptor.provider !== this.name ||
      request.descriptor.provider_version !== this.version
    ) {
      throw new Error("semantic descriptor provider does not match this provider");
    }
    if (
      !Number.isInteger(request.threshold_millionths) ||
      request.threshold_millionths < 1 ||
      request.threshold_millionths > 990_000
    ) {
      throw new Error("semantic threshold must be an integer in 1..990000");
    }
    if (!Number.isInteger(request.top_k) || request.top_k < 1 || request.top_k > 100) {
      throw new Error("semantic top_k must be an integer in 1..100");
    }
    const index = readValidatedIndex(request.descriptor.cache_path);
    if (
      index.provider !== request.descriptor.provider ||
      index.provider_version !== request.descriptor.provider_version ||
      index.input_digest !== request.descriptor.input_digest ||
      index.index_digest !== request.descriptor.index_digest ||
      index.entries.length !== request.descriptor.entry_count
    ) {
      throw new Error("semantic descriptor digest does not match the cached index");
    }
    const byId = new Map(index.entries.map((entry) => [entry.node_id, entry]));
    const suggestions: SemanticSeedSuggestion[] = [];
    for (const sourceId of [...new Set(request.source_node_ids)].sort()) {
      const source = byId.get(sourceId);
      if (source === undefined)
        throw new Error(`semantic source node ${sourceId} is absent from index`);
      const candidates = index.entries
        .filter((candidate) => candidate.node_id !== source.node_id)
        .map((candidate) => ({
          candidate,
          score: weightedJaccard(source.features, candidate.features),
        }))
        .filter(({ score }) => score.millionths >= request.threshold_millionths)
        .sort(
          (left, right) =>
            right.score.millionths - left.score.millionths ||
            compareText(left.candidate.node_id, right.candidate.node_id),
        )
        .slice(0, request.top_k);
      for (const { candidate, score } of candidates) {
        const features = sharedExplanations(source.features, candidate.features);
        suggestions.push({
          source_node_id: source.node_id,
          source_revision: source.revision,
          candidate_node_id: candidate.node_id,
          candidate_revision: candidate.revision,
          score,
          features,
          reason: features
            .slice(0, 5)
            .map((feature) => `${feature.kind}:${feature.token}`)
            .join(", "),
          provider: index.provider,
          provider_version: index.provider_version,
          input_digest: index.input_digest,
          index_digest: index.index_digest,
        });
      }
    }
    return suggestions;
  }
}
