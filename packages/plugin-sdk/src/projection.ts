import type { EdgeRecord, NodeRecord, PluginManifest } from "@universal-harness-internal/core";

/**
 * Projection Provider Plugin Contract (design 13.7, plan Task 24 step 1). A
 * projection is a pure function of authoritative graph state -- never a store.
 * Every document carries its source node ids with revisions plus a generation
 * digest binding view, sources and body, so any upstream revision change
 * produces a new digest and drift detection can prove staleness. Rendering the
 * same ledger state must regenerate byte-identical output.
 *
 * Provider Instruction Projection derives a provider-specific mirror file
 * from the Canonical Pack instruction template plus the Task Envelope and
 * ContextBundle digests it serves. The mirror is never a source of truth:
 * the same inputs must reproduce the same bytes and the same mirror digest,
 * and output is confined to the managed projection root -- a mirror outside
 * the managed path is written only with an explicit user-approved preview.
 */

/** Graph slice a projection renders from. */
export interface ProjectionGraph {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
}

/** One authoritative source a projection was generated from. */
export interface ProjectionSource {
  readonly id: string;
  readonly revision: number;
}

/** A rendered, self-describing projection document. */
export interface ProjectionDocument {
  readonly view: string;
  readonly sources: readonly ProjectionSource[];
  readonly generation_digest: string;
  readonly markdown: string;
}

export interface ProjectionProvider {
  readonly name: string;
  readonly manifest: PluginManifest;
  /** View names the provider can render, e.g. `prd`, `architecture`. */
  readonly views: readonly string[];
  render(view: string, graph: ProjectionGraph): ProjectionDocument;
}

/** Inputs of one Provider Instruction Projection. */
export interface ProviderInstructionInput {
  /** Provider identifier, e.g. `claude` or `codex`; lowercase slug. */
  readonly provider: string;
  /** Canonical Pack instruction template text (already pack-resolved). */
  readonly instruction: string;
  /** Digest of the Task Envelope this instruction serves. */
  readonly task_envelope_digest: string;
  /** Digest of the ContextBundle manifest this instruction serves. */
  readonly context_bundle_digest: string;
}

/** A generated provider mirror: managed output name, bytes and digest. */
export interface ProviderInstructionMirror {
  readonly provider: string;
  /** Path relative to the managed projection root, e.g. `providers/claude.md`. */
  readonly output_name: string;
  readonly content: string;
  /** SHA-256 of the mirror bytes; reproducible from the same inputs. */
  readonly digest: string;
}

export interface ProviderInstructionProjection {
  readonly name: string;
  readonly manifest: PluginManifest;
  project(input: ProviderInstructionInput): ProviderInstructionMirror;
}
