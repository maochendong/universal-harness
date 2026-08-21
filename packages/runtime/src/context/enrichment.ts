import {
  createGroundedSynthesisRecord,
  sealRecordEnvelope,
  contentDigest,
  validateGroundedCitations,
  GROUNDED_SYNTHESIS_SCHEMA_VERSIONS,
  type ContextEnrichmentOutput,
  type GroundedSynthesisPort,
  type GroundedSynthesisRecord,
  type ProjectContextBundleRecord,
} from "@universal-harness-internal/core";

import type { ContextBundleManifest, ContextBundleRecord } from "./compiler.js";
import { readContextBundleManifest } from "./task-bundles.js";

/**
 * Context enrichment consumption (model advisory design 10/11, PG-6, plan
 * T14). The fixed order is select → enrich → compile-persist: enrichment
 * interprets the deterministically selected bundle and persists as a
 * grounded synthesis record bound to the bundle digest. The bundle itself
 * is never modified — enrichment is an interpretation layer, never a source
 * of paths, budgets, bindings or grants. A citation that does not resolve
 * against the exact bundle the model saw fails closed.
 */

/** Project the execution bundle into the citable bundle view. */
export function enrichmentBundleView(record: ContextBundleRecord): ProjectContextBundleRecord {
  const manifest: ContextBundleManifest = readContextBundleManifest(record);
  const sources = manifest.entries.map((entry) => ({
    locator: entry.locator,
    source_kind: "graph" as const,
    source_digest: entry.digest,
    selection_reason: entry.reason,
    classification: "internal_project" as const,
    summary: "",
    truncated: entry.included_tokens < entry.original_tokens,
  }));
  const base = {
    protocol_version: "1.1.0",
    record_kind: "project_context_bundle",
    bundle_id: record.context_bundle_id,
    session_id: record.task_id,
    purpose: "context_enrichment",
    project_baseline_digest: manifest.bindings.requirement_baseline_digest,
    profile_digest: manifest.bindings.policy_digest,
    policy_digest: manifest.bindings.policy_digest,
    budget: {
      max_files: Math.max(manifest.entries.length, 1),
      max_bytes_per_source: Math.max(manifest.token_budget * 4, 1),
      max_total_bytes: Math.max(manifest.token_budget * 4, 1),
      max_summary_chars: 4000,
    },
    sources,
    exclusions: manifest.exclusions.map((exclusion) => ({
      locator: exclusion.locator,
      reason: "budget_exceeded",
    })),
    content_digest: manifest.content_digest,
  };
  return sealRecordEnvelope(base) as unknown as ProjectContextBundleRecord;
}

export type ContextEnrichmentOutcome =
  | { readonly status: "enriched"; readonly record: GroundedSynthesisRecord }
  | {
      readonly status: "failed";
      readonly failure: {
        readonly code: string;
        readonly summary: string;
        readonly retryable: boolean;
      };
    };

export async function enrichContextBundle(input: {
  readonly port: GroundedSynthesisPort;
  readonly bundleRecord: ContextBundleRecord;
  readonly conversation_id: string;
  readonly run_id: string;
}): Promise<ContextEnrichmentOutcome> {
  const view = enrichmentBundleView(input.bundleRecord);
  const result = await input.port.synthesize({
    purpose: "context_enrichment",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.context_enrichment,
    binding_digest: input.bundleRecord.digest,
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    bundle: view,
  });
  if (result.status === "failed") {
    return { status: "failed", failure: result.failure };
  }
  const output = result.output as ContextEnrichmentOutput;
  const citationIssues = validateGroundedCitations(output, view);
  if (citationIssues.length > 0) {
    return {
      status: "failed",
      failure: {
        code: "citation_invalid",
        summary: `context enrichment citations failed: ${citationIssues
          .map((issue) => issue.claim_path)
          .join(", ")}`,
        retryable: false,
      },
    };
  }
  const record = createGroundedSynthesisRecord({
    purpose: "context_enrichment",
    binding_digest: input.bundleRecord.digest,
    bundle_digest: view.record_digest,
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    input_digest: contentDigest({
      bundle_digest: view.record_digest,
      binding_digest: input.bundleRecord.digest,
    }),
    output,
  });
  return { status: "enriched", record };
}
