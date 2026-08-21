import {
  canonicalizeJson,
  contentDigest,
  createGroundedSynthesisRecord,
  sealRecordEnvelope,
  validateGroundedCitations,
  GROUNDED_SYNTHESIS_SCHEMA_VERSIONS,
  PROTOCOL_VERSION,
  type IterationNarrativeOutput,
  type ProjectContextBundleRecord,
} from "@universal-harness-internal/core";

import type { PipelineContext } from "../orchestration/kernel-coordinator.js";
import {
  artifactExists,
  commitArtifacts,
  currentAttemptId,
  nowOf,
} from "../orchestration/kernel-coordinator.js";

/**
 * Post-snapshot iteration narrative (model advisory design 10/11.3, PG-7,
 * plan T17): the narrative is compiled only after the authoritative
 * snapshot commits. It never modifies the snapshot, a verdict or evidence;
 * every claim cites the snapshot bundle by locator and digest. A failure —
 * provider, invalid output or a citation that does not resolve — produces
 * a recoverable projection Finding and nothing else.
 */
function narrativeBundleView(
  ctx: PipelineContext,
  snapshot: { readonly snapshot_id: string },
  snapshotDigest: string,
): ProjectContextBundleRecord {
  const base = {
    protocol_version: "1.1.0",
    record_kind: "project_context_bundle",
    bundle_id: `narrative-bundle_${snapshot.snapshot_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
    session_id: ctx.iterationId,
    purpose: "context_enrichment",
    project_baseline_digest: ctx.baselineDigest,
    profile_digest: ctx.workingState.policy_digest,
    policy_digest: ctx.workingState.policy_digest,
    budget: {
      max_files: 1,
      max_bytes_per_source: 16000,
      max_total_bytes: 16000,
      max_summary_chars: 4000,
    },
    sources: [
      {
        locator: `harness://snapshots/${snapshot.snapshot_id}`,
        source_kind: "graph" as const,
        source_digest: snapshotDigest,
        selection_reason: "the committed authoritative snapshot",
        classification: "internal_project" as const,
        summary: "",
        truncated: false,
      },
    ],
    exclusions: [],
    content_digest: contentDigest({ snapshot: snapshot.snapshot_id, digest: snapshotDigest }),
  };
  return sealRecordEnvelope(base) as unknown as ProjectContextBundleRecord;
}

/** Commit a recoverable projection Finding; never blocks the snapshot. */
async function commitProjectionFinding(
  ctx: PipelineContext,
  snapshotId: string,
  detail: string,
): Promise<void> {
  const id = `finding_${contentDigest(`${ctx.iterationId}:iteration_narrative:${detail}`).slice(0, 16)}`;
  const path = `artifacts/findings/${id}/1.json`;
  if (artifactExists(ctx.deps, path)) return;
  const content: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id,
    type: "Finding",
    revision: 1,
    status: "proposed",
    source: "workflow",
    provenance: {
      iteration_id: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(ctx.deps),
    },
    confidence: 1,
    extensions: {
      "harness.finding": {
        origin: "runtime",
        blocking: false,
        violates: [],
        blocks: [],
        evidence: [],
        rule: "projection/iteration_narrative",
        scope_prefix: "projection",
        severity: "warning",
        actionability: "human_review",
        subject_ids: [snapshotId],
        subject_digests: [],
        summary: detail,
      },
    },
  };
  const node = { ...content, digest: contentDigest(content) };
  await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    { path, content: `${canonicalizeJson(node)}\n` },
  ]);
}

export async function narrateIteration(
  ctx: PipelineContext,
  snapshot: { readonly snapshot_id: string },
  snapshotDigest: string,
): Promise<void> {
  const port = ctx.deps.iterationNarrative;
  if (port === undefined) return;
  const view = narrativeBundleView(ctx, snapshot, snapshotDigest);
  const conversationId = `iteration-narrative-conversation_${ctx.workflowOperationId.replace(/^[a-z][a-z0-9-]*_/u, "")}`;
  const runId = `iteration-narrative-run_${currentAttemptId(ctx)}`;
  const result = await port.synthesize({
    purpose: "iteration_narrative",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.iteration_narrative,
    binding_digest: snapshotDigest,
    conversation_id: conversationId,
    run_id: runId,
    bundle: view,
  });
  if (result.status === "failed") {
    await commitProjectionFinding(
      ctx,
      snapshot.snapshot_id,
      `iteration narrative failed: ${result.failure.summary}`,
    );
    return;
  }
  const output = result.output as IterationNarrativeOutput;
  const citationIssues = validateGroundedCitations(output, view);
  if (citationIssues.length > 0) {
    await commitProjectionFinding(
      ctx,
      snapshot.snapshot_id,
      `iteration narrative citations invalid: ${citationIssues
        .map((issue) => issue.claim_path)
        .join(", ")}`,
    );
    return;
  }
  const record = createGroundedSynthesisRecord({
    purpose: "iteration_narrative",
    binding_digest: snapshotDigest,
    bundle_digest: view.record_digest,
    conversation_id: conversationId,
    run_id: runId,
    input_digest: contentDigest({
      bundle_digest: view.record_digest,
      binding_digest: snapshotDigest,
    }),
    output,
  });
  const path = `artifacts/iteration-narratives/${record.grounded_synthesis_id}.json`;
  if (artifactExists(ctx.deps, path)) return;
  await commitArtifacts(ctx.deps, ctx.workflowOperationId, currentAttemptId(ctx), [
    { path, content: `${canonicalizeJson(record)}\n` },
  ]);
}
