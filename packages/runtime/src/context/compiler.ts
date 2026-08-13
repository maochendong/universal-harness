import {
  PROTOCOL_VERSION,
  contentDigest,
  sha256Hex,
  validateSchema,
  type NodeRecord,
} from "@universal-harness-internal/core";

import { allocateTierBudgets, estimateTokens, type TierAllocation } from "./budget.js";
import {
  NO_COMPRESSION,
  assertProtectedFieldsPresent,
  createTruncateCompressor,
  type Compressor,
} from "./compression.js";
import {
  ContextError,
  knowledgeLayerFor,
  type KnowledgeLayerTag,
  type SourceTier,
} from "./selector.js";

/**
 * ContextBundle compilation (design 13.4 and completion rule 10). The
 * compiler assembles the minimal, traceable bundle for one task: candidates
 * arrive with an explicit priority tier and selection reason, caller and
 * budget exclusions are recorded, every kept source is compressed under its
 * tier allocation without losing protected content, and the result is an
 * immutable manifest whose digest is the bundle's identity. The assembled
 * raw context is returned separately: when policy marks a source sensitive
 * the manifest only carries its reference, digest and sizes, and the raw
 * text stays local (design 8.4).
 *
 * Compilation is pure and metadata-free — no timestamps, no minted ids — so
 * recompiling the same inputs reproduces the exact same manifest, digest
 * and record. Adjacent DAG tasks compile independently; nothing mutable is
 * shared between bundles.
 */
export const CONTEXT_EXTENSION_KEY = "harness.context";

export type Freshness = "fresh" | "stale";

/** Authoritative digests the bundle is compiled against (design 10.3). */
export interface BundleBindings {
  readonly requirement_baseline_digest: string;
  readonly policy_digest: string;
  readonly plan_digest: string;
  readonly approval_digests: readonly string[];
}

export interface ContextCandidate {
  readonly node: NodeRecord;
  readonly content: string;
  /** Assembly priority tier (design 13.4); lower tiers assemble first. */
  readonly tier: SourceTier;
  /** Why this source was selected for the task. */
  readonly reason: string;
  /** Verbatim content spans compression must never remove. */
  readonly protectedFields?: readonly string[];
  /** Policy marked the content sensitive: raw text stays local only. */
  readonly sensitive?: boolean;
}

export interface SourceExclusion {
  readonly nodeId: string;
  readonly reason: string;
}

export interface ContextSourceEntry {
  readonly node_id: string;
  readonly revision: number;
  /** Source content digest at compile time; drift invalidates the bundle. */
  readonly digest: string;
  readonly knowledge_layer: KnowledgeLayerTag;
  readonly reason: string;
  readonly priority: SourceTier;
  readonly freshness: Freshness;
  readonly original_tokens: number;
  readonly included_tokens: number;
  readonly compression: string;
  readonly sensitive: boolean;
}

export interface ExcludedSource {
  readonly node_id: string;
  readonly reason: string;
}

/** Immutable, metadata-free bundle manifest; `content_digest` is its identity. */
export interface ContextBundleManifest {
  readonly content_digest: string;
  readonly task_id: string;
  readonly goal: string;
  readonly bindings: BundleBindings;
  readonly token_budget: number;
  readonly tier_allocations: readonly TierAllocation[];
  readonly entries: readonly ContextSourceEntry[];
  readonly exclusions: readonly ExcludedSource[];
  readonly original_tokens: number;
  readonly included_tokens: number;
}

/** Matches `ContextBundleRecordSchema` in core; validated on build. */
export interface ContextBundleRecord {
  readonly protocol_version: string;
  readonly record_kind: "context_bundle";
  readonly context_bundle_id: string;
  readonly task_id: string;
  readonly source_digests: readonly string[];
  readonly digest: string;
  readonly stale: boolean;
  readonly extensions?: Record<string, unknown>;
}

export interface CompiledContextBundle {
  readonly manifest: ContextBundleManifest;
  readonly record: ContextBundleRecord;
  /** Assembled raw context; local-only when any entry is sensitive. */
  readonly assembled: string;
}

export interface CompileContextInput {
  readonly taskId: string;
  readonly goal: string;
  readonly bindings: BundleBindings;
  readonly tokenBudget: number;
  readonly candidates: readonly ContextCandidate[];
  readonly exclusions?: readonly SourceExclusion[];
  /** Pluggable compressor; defaults to the deterministic truncate-v1. */
  readonly compressor?: Compressor;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Sort key shared by entries and assembly: tier first, then node id. */
function byTierThenId(
  left: { readonly tier: SourceTier; readonly id: string },
  right: { readonly tier: SourceTier; readonly id: string },
): number {
  return left.tier - right.tier || left.id.localeCompare(right.id);
}

export function compileContextBundle(input: CompileContextInput): CompiledContextBundle {
  if (!Number.isInteger(input.tokenBudget) || input.tokenBudget < 1) {
    throw new ContextError(
      "invalid_budget",
      `token budget must be a positive integer, got ${String(input.tokenBudget)}`,
    );
  }
  const compressor = input.compressor ?? createTruncateCompressor();
  const exclusions: ExcludedSource[] = [];
  const callerExclusions = new Map<string, string>();
  for (const exclusion of input.exclusions ?? []) {
    callerExclusions.set(exclusion.nodeId, exclusion.reason);
    exclusions.push({ node_id: exclusion.nodeId, reason: exclusion.reason });
  }

  // Deterministic candidate order; a node offered twice keeps its highest
  // priority candidate and the rest are recorded as duplicate exclusions.
  const ordered = [...input.candidates]
    .map((candidate) => ({ ...candidate, id: candidate.node.id }))
    .sort(byTierThenId);
  const seen = new Set<string>();
  const selected: typeof ordered = [];
  for (const candidate of ordered) {
    assertProtectedFieldsPresent(candidate.id, candidate.content, candidate.protectedFields ?? []);
    if (callerExclusions.has(candidate.id)) continue;
    if (seen.has(candidate.id)) {
      exclusions.push({ node_id: candidate.id, reason: "duplicate_source" });
      continue;
    }
    seen.add(candidate.id);
    selected.push(candidate);
  }

  const allocations = allocateTierBudgets(input.tokenBudget);
  const remaining = new Map<SourceTier, number>(
    allocations.map((allocation) => [allocation.tier, allocation.tokens]),
  );
  const entries: ContextSourceEntry[] = [];
  const compressedContent = new Map<string, string>();
  for (const candidate of selected) {
    const tierBudget = remaining.get(candidate.tier) ?? 0;
    const result = compressor.compress(
      candidate.content,
      tierBudget,
      candidate.protectedFields ?? [],
    );
    if (result.content.length === 0 && candidate.content.length > 0) {
      exclusions.push({ node_id: candidate.id, reason: "budget_exhausted" });
      continue;
    }
    remaining.set(candidate.tier, Math.max(0, tierBudget - result.includedTokens));
    compressedContent.set(candidate.id, result.content);
    entries.push({
      node_id: candidate.id,
      revision: candidate.node.revision,
      digest: sha256Hex(candidate.content),
      knowledge_layer: knowledgeLayerFor(candidate.node.type),
      reason: candidate.reason,
      priority: candidate.tier,
      freshness: "fresh",
      original_tokens: estimateTokens(candidate.content),
      included_tokens: result.includedTokens,
      compression: result.method === NO_COMPRESSION ? NO_COMPRESSION : compressor.id,
      sensitive: candidate.sensitive ?? false,
    });
  }
  if (entries.length === 0) {
    throw new ContextError("invalid_source", "context bundle requires at least one source");
  }
  entries.sort((left, right) =>
    byTierThenId(
      { tier: left.priority, id: left.node_id },
      { tier: right.priority, id: right.node_id },
    ),
  );

  const assembled = entries
    .map(
      (entry) =>
        `## source: ${entry.node_id} (revision ${entry.revision}, priority ${entry.priority}, layer ${entry.knowledge_layer})\n${compressedContent.get(entry.node_id) ?? ""}`,
    )
    .join("\n\n");

  const base = {
    task_id: input.taskId,
    goal: input.goal,
    bindings: {
      requirement_baseline_digest: input.bindings.requirement_baseline_digest,
      policy_digest: input.bindings.policy_digest,
      plan_digest: input.bindings.plan_digest,
      approval_digests: [...input.bindings.approval_digests].sort(),
    },
    token_budget: input.tokenBudget,
    tier_allocations: allocations,
    entries,
    exclusions,
    original_tokens: entries.reduce((sum, entry) => sum + entry.original_tokens, 0),
    included_tokens: entries.reduce((sum, entry) => sum + entry.included_tokens, 0),
  };
  const manifest: ContextBundleManifest = {
    ...base,
    content_digest: contentDigest(base),
  };

  const record: ContextBundleRecord = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "context_bundle",
    context_bundle_id: `bundle_${manifest.content_digest.slice(0, 16)}`,
    task_id: input.taskId,
    source_digests: [...new Set(entries.map((entry) => entry.digest))].sort(),
    digest: manifest.content_digest,
    stale: false,
  };
  const validation = validateSchema("runtime", record);
  if (!validation.valid) {
    throw new ContextError(
      "invalid_record",
      `invalid context bundle record: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  return deepFreeze({ manifest, record, assembled });
}
