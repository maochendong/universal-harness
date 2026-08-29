import {
  buildCollaborationRecord,
  buildManifest,
  canonicalizeJson,
  contentDigest,
  edgeShardRelativePath,
  eventShardRelativePath,
  harnessRootFor,
  mergeCommittedOperations,
  replayLedger,
  sha256Hex,
  shardMonthFor,
  validateSchema,
  type CollaborationConnectionRecord,
  type ControlRecord,
  type IntegrationRecord,
  type LeaseRecord,
  type LedgerOperation,
  type PrincipalSnapshotRecord,
  type ReplayResult,
} from "@universal-harness-internal/core";
import { materializeLedger } from "@universal-harness-internal/graph";

import { bindingDrift } from "../approval/invalidation.js";
import type { ApprovalRequestRecord } from "../approval/request.js";
import {
  readGateEvidenceExtension,
  type GateEvidenceExtension,
  type GateEvidenceRecord,
} from "../gates/evidence.js";
import { evidenceStalenessReasons } from "../gates/freshness.js";
import { hashWorktreeCode } from "../snapshot/anchor.js";
import { snapshotIdFor } from "./connection.js";
import { collaborationFailure, type CollaborationFailure } from "./errors.js";
import { sealLeaseRecord, transitionAcquireLease, transitionLease } from "./lease.js";
import { LedgerResequenceError, resequenceCandidateLedger } from "./ledger-resequence.js";
import type {
  CandidateArtifact,
  CandidateFileWrite,
  CandidateMergeView,
  CandidatePlan,
  CollaborationSession,
  ControlSnapshot,
  GitControlStorePort,
  PrincipalSnapshotFacts,
} from "./port.js";

/**
 * Integration slice (design §14): prepare and accept of two-parent candidate
 * merge commits. The Coordinator authenticates and authorizes the actor, then
 * this module runs the deterministic pipeline:
 *
 * - prepare: acquire the short-lived per-project Integration Lease, let the
 *   Git Adapter build the clean three-way merge, plan the candidate-only
 *   Ledger resequencing plus the fixed-path IntegrationRecord on top of it
 *   (`resequenceCandidateLedger`, design §14.2/§14.3), then re-run the
 *   tree-based validation chain on the candidate root: full Ledger replay,
 *   sequence linearity, `mergeCommittedOperations` strictness against the
 *   accepted Target history, Graph materialization, mandatory Gate evidence
 *   and Approval binding checks (design §14.1 step 7).
 * - accept: re-read the staged candidate, re-validate the Integration Lease
 *   and fencing token, recompute the whole deterministic plan from the frozen
 *   merge inputs and require it to reproduce the staged record and tree byte
 *   for byte (design §14.3's deterministic identity rule), re-run validation,
 *   then compare-and-swap the Target ref.
 *
 * Determinism note: the candidate commit OID is NOT deterministic (the Git
 * commit carries wall-clock timestamps); the deterministic identity of a
 * candidate is its tree. That is why the IntegrationRecord never embeds a
 * commit OID and accept compares tree OIDs, never commit OIDs.
 *
 * Recovery: a lost Target CAS response is recovered from the Target history
 * by matching the integration id and the record digest (design §14.4); the
 * digest canonically covers the record's command id and every frozen field.
 * The accepted outcome is only returned after the Target provably contains
 * the candidate. The final candidate transaction's event shard carries the
 * deterministic `IntegrationAccepted` LifecycleEvent (Protocol 1.2, bound to
 * the integration record digest); it enters the project Ledger only when the
 * Target CAS accepts the candidate, which is what makes it an accepted fact
 * rather than a claim (design §20).
 *
 * Validation scope (honest gaps in design §14.1 step 7): the Coordinator
 * recomputes the policy digest binding and the candidate code digest
 * (`hashWorktreeCode` over the candidate worktree) for Gate evidence
 * freshness. It cannot recompute:
 *
 * - Impact: the impact machinery needs the planning phase's seeds and frozen
 *   impact-set approval context; no standalone impact check runs on a
 *   materialized graph, so the candidate is only required to materialize
 *   cleanly (Graph reconcile above);
 * - the evidence artifact / context-bundle / gate / evaluation-case bindings:
 *   the bindings store digests only, never paths, so the current set cannot
 *   be rebuilt from the tree;
 * - the approval object / baseline / impact-path bindings: those digests are
 *   minted from replica planning state (e.g. the proposed content digest, the
 *   captured baseline), not from anything addressable in the candidate tree.
 *
 * These dimensions bind domain state that the replica's existing Snapshot
 * rules re-check after the accepted Target syncs back; here they are replayed
 * verbatim so the checks still fail closed when the branch itself drifted.
 */

export interface IntegrationDeps {
  readonly controlStore: GitControlStorePort;
  readonly control_ref: string;
  readonly now: () => string;
}

export interface PrepareIntegrationInput {
  readonly command_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly operation_commit: string;
  readonly expected_target_commit: string;
  readonly connection: CollaborationConnectionRecord;
  readonly control: ControlSnapshot;
  readonly session: CollaborationSession;
  /** Fresh, already-authenticated platform facts for the acting principal. */
  readonly snapshot_facts: PrincipalSnapshotFacts;
}

export type PrepareIntegrationResult =
  | {
      readonly status: "prepared";
      readonly integration_record: IntegrationRecord;
      readonly candidate_commit: string;
      /** Control Ref records this call appended (snapshot, lease). */
      readonly appended: readonly ControlRecord[];
      readonly replayed: boolean;
    }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

export interface AcceptIntegrationInput {
  readonly command_id: string;
  readonly project_id: string;
  readonly integration_id: string;
  readonly expected_target_commit: string;
  readonly connection: CollaborationConnectionRecord;
  readonly control: ControlSnapshot;
  readonly session: CollaborationSession;
}

export type AcceptIntegrationResult =
  | {
      readonly status: "accepted";
      readonly integration_record: IntegrationRecord;
      readonly target_commit: string;
      /** Control Ref records this call appended (best-effort lease release). */
      readonly appended: readonly ControlRecord[];
      readonly replayed: boolean;
    }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

/** Deterministic candidate identity: the frozen merge inputs, nothing else. */
export function integrationIdFor(operationCommit: string, expectedTargetCommit: string): string {
  return `integration_${contentDigest({ operationCommit, expectedTargetCommit }).slice(0, 24)}`;
}

function failed(failure: CollaborationFailure): {
  readonly status: "failed";
  readonly failure: CollaborationFailure;
} {
  return { status: "failed", failure };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integrationLeaseHistory(
  records: readonly ControlRecord[],
  projectId: string,
): LeaseRecord[] {
  return records.filter(
    (record): record is LeaseRecord =>
      record.record_kind === "lease" &&
      (record as LeaseRecord).resource_kind === "integration" &&
      (record as LeaseRecord).resource_id === projectId,
  );
}

/** Parse a JSON artifact; non-JSON artifacts are opaque content, never records. */
function parseArtifact(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface ApprovalRequestShape {
  readonly request_id: string;
  readonly object_digest: string;
  readonly baseline_digest: string;
  readonly policy_digest: string;
  readonly impact_path: readonly string[];
}

function approvalRequestShapeOf(parsed: Record<string, unknown>): ApprovalRequestShape | undefined {
  const candidate = parsed as Partial<ApprovalRequestShape>;
  if (
    typeof candidate.request_id !== "string" ||
    typeof candidate.object_digest !== "string" ||
    typeof candidate.baseline_digest !== "string" ||
    typeof candidate.policy_digest !== "string" ||
    !Array.isArray(candidate.impact_path) ||
    candidate.impact_path.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  return candidate as ApprovalRequestShape;
}

/** The digests the IntegrationRecord proves over (sorted, deduplicated). */
function collectProofDigests(artifacts: readonly CandidateArtifact[]): {
  readonly evidence_digests: string[];
  readonly approval_decision_digests: string[];
} {
  const evidence = new Set<string>();
  const approvals = new Set<string>();
  for (const artifact of artifacts) {
    const parsed = parseArtifact(artifact.content);
    if (parsed === undefined) continue;
    if (
      parsed.record_kind === "evidence" &&
      readGateEvidenceExtension(parsed as unknown as GateEvidenceRecord) !== undefined
    ) {
      evidence.add(artifact.digest);
    } else if (parsed.record_kind === "approval_decision") {
      approvals.add(artifact.digest);
    }
  }
  return {
    evidence_digests: [...evidence].sort(),
    approval_decision_digests: [...approvals].sort(),
  };
}

/**
 * The Coordinator's deterministic candidate plan (design §14.2/§14.3). Pure:
 * given the parsed merge view it resequences incoming-only manifests, builds
 * the IntegrationRecord and the final integration Ledger transaction, and
 * lists exactly the files the Adapter writes into the candidate tree. The
 * final manifest's `committed_at` derives from the incoming history (never
 * the wall clock) so accept's recomputation reproduces the same tree.
 */
export function planIntegrationCandidate(input: {
  readonly integration_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly expected_target_commit: string;
  readonly operation_commit: string;
  readonly lease_fencing_token: number;
  readonly command_id: string;
  readonly merge: CandidateMergeView;
}): CandidatePlan {
  let resequence;
  try {
    resequence = resequenceCandidateLedger({
      target: input.merge.target_operations,
      incoming: input.merge.incoming_operations,
    });
  } catch (error) {
    if (error instanceof LedgerResequenceError) {
      return failed(collaborationFailure("ledger_resequence_failed", error.message));
    }
    throw error;
  }
  if (resequence.manifests.length === 0) {
    return failed(
      collaborationFailure(
        "ledger_resequence_failed",
        "operation branch adds no new ledger operations; there is nothing to integrate",
      ),
    );
  }

  const proof = collectProofDigests(input.merge.incoming_artifacts);
  const record = buildCollaborationRecord({
    record_kind: "integration" as const,
    integration_id: input.integration_id,
    operation_id: input.operation_id,
    expected_target_commit: input.expected_target_commit,
    operation_commit: input.operation_commit,
    lease_fencing_token: input.lease_fencing_token,
    ledger_sequence_rewrites: [...resequence.rewrites],
    evidence_digests: proof.evidence_digests,
    approval_decision_digests: proof.approval_decision_digests,
    command_id: input.command_id,
  });
  const recordContent = `${canonicalizeJson(record)}\n`;

  // The final candidate Ledger transaction carrying the IntegrationRecord;
  // sequence max(resequenced) + 1 (design §14.2 step 6, plan Task 6 Step 4).
  const last = resequence.manifests[resequence.manifests.length - 1] as LedgerOperation;
  const committedAt = resequence.manifests.reduce(
    (maximum, manifest) => (manifest.committed_at > maximum ? manifest.committed_at : maximum),
    last.committed_at,
  );
  const manifestId = `ledger-integration_${contentDigest({ integrationId: input.integration_id }).slice(0, 24)}`;
  const month = shardMonthFor(committedAt);
  const edgeFile = edgeShardRelativePath(month, manifestId);
  const eventFile = eventShardRelativePath(month, manifestId);
  const emptyShardDigest = sha256Hex("");

  // The final transaction is synthetic — no workflow operation produced it —
  // so it gets its own deterministic workflow/attempt identifiers derived
  // from the integration id. That keeps the event's operation binding intact
  // and makes its sequence 1 unambiguous: no earlier events exist for this
  // workflow operation id on either branch.
  const syntheticDigest = contentDigest({ integrationId: input.integration_id }).slice(0, 24);
  const workflowOperationId = `workflow_integration_${syntheticDigest}`;
  const acceptedEvent = {
    protocol_version: "1.2.0",
    record_kind: "event" as const,
    event_id: `event_integration_${syntheticDigest}`,
    event_type: "IntegrationAccepted" as const,
    project_id: input.project_id,
    iteration_id: "iteration_integration",
    workflow_operation_id: workflowOperationId,
    ledger_operation_id: manifestId,
    sequence: 1,
    timestamp: committedAt,
    payload: {
      integration_id: input.integration_id,
      operation_id: input.operation_id,
      expected_target_commit: input.expected_target_commit,
      operation_commit: input.operation_commit,
      lease_fencing_token: input.lease_fencing_token,
      record_digest: record.record_digest,
    },
  };
  const eventValidation = validateSchema("event", acceptedEvent);
  if (!eventValidation.valid) {
    return failed(
      collaborationFailure(
        "ledger_resequence_failed",
        `the IntegrationAccepted event does not satisfy the event schema: ${eventValidation.errors
          .map((issue) => `${issue.instancePath}: ${issue.message}`)
          .join("; ")}`,
      ),
    );
  }
  const eventContent = `${canonicalizeJson(acceptedEvent)}\n`;

  const finalManifest = buildManifest({
    ledger_operation_id: manifestId,
    workflow_operation_id: workflowOperationId,
    attempt_id: `attempt_integration_${syntheticDigest}`,
    baseline_commit: input.expected_target_commit,
    sequence: last.sequence + 1,
    artifact_digests: [sha256Hex(recordContent)],
    edge_file: edgeFile,
    event_file: eventFile,
    edge_file_digest: emptyShardDigest,
    event_file_digest: sha256Hex(eventContent),
    // The transaction carries Protocol 1.2 records (IntegrationRecord
    // artifact, IntegrationAccepted event).
    required_reader_version: "1.2.0",
    committed_at: committedAt,
  });

  const rewrittenIds = new Set(resequence.rewrites.map((rewrite) => rewrite.ledger_operation_id));
  const writes: CandidateFileWrite[] = [];
  for (const manifest of resequence.manifests) {
    if (!rewrittenIds.has(manifest.ledger_operation_id)) continue;
    writes.push({
      path: `.harness/ledger/operations/${manifest.ledger_operation_id}.json`,
      content: `${canonicalizeJson(manifest)}\n`,
    });
  }
  writes.push({
    path: `.harness/artifacts/integrations/${input.integration_id}.json`,
    content: recordContent,
  });
  writes.push({
    path: `.harness/ledger/operations/${manifestId}.json`,
    content: `${canonicalizeJson(finalManifest)}\n`,
  });
  writes.push({ path: `.harness/${edgeFile}`, content: "" });
  writes.push({ path: `.harness/${eventFile}`, content: eventContent });
  return { status: "planned", record, writes };
}

/**
 * The prepare/accept validation chain (design §14.1 step 7) against the
 * materialized candidate tree. Returns the failure to report, or undefined.
 */
export function validateCandidateTree(input: {
  readonly candidate_root: string;
  readonly policy_digest: string;
  readonly target_operations: readonly LedgerOperation[];
  readonly incoming_artifacts: readonly CandidateArtifact[];
}): CollaborationFailure | undefined {
  const harnessRoot = harnessRootFor(input.candidate_root);

  // Full Ledger replay: shard bytes verified against manifest digests.
  let replay: ReplayResult;
  try {
    replay = replayLedger(harnessRoot);
  } catch (error) {
    return collaborationFailure(
      "ledger_resequence_failed",
      `candidate ledger replay failed: ${errorMessage(error)}`,
    );
  }

  // The candidate history is one linear 1..N chain.
  const sequences = replay.operations.map((operation) => operation.manifest.sequence);
  for (let index = 0; index < sequences.length; index += 1) {
    if (sequences[index] !== index + 1) {
      return collaborationFailure(
        "ledger_resequence_failed",
        `candidate ledger sequence is not linear: position ${index + 1} holds sequence ${sequences[index]}`,
      );
    }
  }

  // The accepted Target history survives unchanged inside the candidate;
  // mergeCommittedOperations stays strict for accepted histories.
  try {
    mergeCommittedOperations(
      input.target_operations.map((manifest) => ({ manifest, manifestPath: "" })),
      replay.operations,
    );
  } catch (error) {
    return collaborationFailure(
      "ledger_resequence_failed",
      `candidate ledger no longer contains the accepted target history: ${errorMessage(error)}`,
    );
  }

  // Graph reconcile: the candidate tree must materialize cleanly.
  try {
    const materialization = materializeLedger({
      projectRoot: input.candidate_root,
      databasePath: ":memory:",
    });
    materialization.database.close();
  } catch (error) {
    return collaborationFailure(
      "ledger_resequence_failed",
      `candidate graph materialization failed: ${errorMessage(error)}`,
    );
  }

  // Mandatory Gate evidence carried by the incoming branch. The code binding
  // is recomputable here: the candidate root is a Git worktree, so its code
  // digest is recomputed exactly the way the replica binds it (any code the
  // merge added beyond what the evidence covered makes the binding stale).
  let candidateCode: string[] | undefined;
  const currentCodeDigests = (): string[] => {
    candidateCode ??= [hashWorktreeCode(input.candidate_root)];
    return candidateCode;
  };
  for (const artifact of input.incoming_artifacts) {
    const parsed = parseArtifact(artifact.content);
    if (parsed === undefined || parsed.record_kind !== "evidence") continue;
    const record = parsed as unknown as GateEvidenceRecord;
    const extension: GateEvidenceExtension | undefined = readGateEvidenceExtension(record);
    if (extension === undefined || !extension.mandatory) continue;
    const gate = `mandatory gate ${extension.gate_id} evidence ${record.evidence_id}`;
    if (!extension.passed) {
      return collaborationFailure(
        "integration_gate_failed",
        `${gate} did not pass; resolve it on the operation branch and re-prepare`,
      );
    }
    if (record.provisional) {
      return collaborationFailure(
        "integration_gate_failed",
        `${gate} is provisional and can never satisfy integration`,
      );
    }
    // The policy and code bindings are recomputable by the Coordinator (see
    // the module header); every other bound digest is replayed verbatim so
    // the check still fails closed on those bindings drifting on the branch.
    let staleness: readonly string[];
    try {
      staleness = evidenceStalenessReasons(record, {
        artifact_digests: extension.bindings.artifact_digests,
        code_digests: currentCodeDigests(),
        ...(extension.bindings.context_bundle_digest === undefined
          ? {}
          : { context_bundle_digest: extension.bindings.context_bundle_digest }),
        gate_digest: extension.bindings.gate_digest,
        evaluation_case_digests: extension.bindings.evaluation_case_digests,
        policy_digest: input.policy_digest,
      });
    } catch (error) {
      return collaborationFailure(
        "coordinator_unavailable",
        `cannot recompute the candidate code digest for evidence freshness: ${errorMessage(error)}`,
        true,
      );
    }
    if (staleness.length > 0) {
      return collaborationFailure(
        "integration_gate_failed",
        `${gate} is stale on the candidate: ${staleness.join(", ")}`,
      );
    }
  }

  // Approval requests whose bindings the baseline change could invalidate.
  for (const artifact of input.incoming_artifacts) {
    const parsed = parseArtifact(artifact.content);
    if (parsed === undefined || parsed.record_kind !== "approval_request") continue;
    const request = approvalRequestShapeOf(parsed);
    if (request === undefined) {
      return collaborationFailure(
        "approval_binding_mismatch",
        "an incoming approval request artifact is malformed; re-issue it before integrating",
      );
    }
    // As with evidence, only the policy binding is recomputable here.
    const drift = bindingDrift(request as unknown as ApprovalRequestRecord, {
      objectDigest: request.object_digest,
      baselineDigest: request.baseline_digest,
      policyDigest: input.policy_digest,
      impactPath: request.impact_path,
    });
    if (drift.length > 0) {
      return collaborationFailure(
        "approval_binding_mismatch",
        `approval request ${request.request_id} bindings drifted: ${drift.join(", ")}`,
      );
    }
  }

  return undefined;
}

interface RecomputedCandidate {
  readonly tree_oid: string;
  readonly merge: CandidateMergeView;
  readonly candidate_root: string;
}

/**
 * Rebuild the candidate from the frozen inputs recorded in `record` and
 * require the recomputation to reproduce the staged record byte for byte and
 * the staged tree exactly, then re-run the full validation chain. This is
 * accept's tampering defense and prepare's replay verification.
 */
async function recomputeAndValidate(
  deps: IntegrationDeps,
  input: {
    readonly project_id: string;
    readonly operation_id: string;
    readonly connection: CollaborationConnectionRecord;
    readonly record: IntegrationRecord;
    readonly staged_tree_oid: string;
  },
): Promise<
  | { readonly status: "ok"; readonly candidate: RecomputedCandidate }
  | { readonly status: "failed"; readonly failure: CollaborationFailure }
> {
  let observed: CandidateMergeView | undefined;
  const prepared = await deps.controlStore.prepareCandidate({
    project_id: input.project_id,
    operation_id: input.record.operation_id,
    target_ref: input.connection.target_ref,
    expected_target_commit: input.record.expected_target_commit,
    operation_commit: input.record.operation_commit,
    plan: (merge) => {
      observed = merge;
      const plan = planIntegrationCandidate({
        integration_id: input.record.integration_id,
        project_id: input.project_id,
        operation_id: input.record.operation_id,
        expected_target_commit: input.record.expected_target_commit,
        operation_commit: input.record.operation_commit,
        lease_fencing_token: input.record.lease_fencing_token,
        command_id: input.record.command_id,
        merge,
      });
      if (plan.status === "failed") return plan;
      if (canonicalizeJson(plan.record) !== canonicalizeJson(input.record)) {
        return {
          status: "failed" as const,
          failure: collaborationFailure(
            "ledger_resequence_failed",
            "the staged integration record does not recompute deterministically from the frozen merge inputs",
          ),
        };
      }
      return plan;
    },
  });
  if (prepared.status === "failed") return failed(prepared.failure);
  if (observed === undefined) {
    return failed(
      collaborationFailure(
        "coordinator_unavailable",
        "candidate preparation produced no merge view",
      ),
    );
  }
  const merge = observed as CandidateMergeView;
  if (prepared.tree_oid !== input.staged_tree_oid) {
    return failed(
      collaborationFailure(
        "ledger_resequence_failed",
        "the recomputed candidate tree does not match the staged candidate",
      ),
    );
  }
  const invalid = validateCandidateTree({
    candidate_root: prepared.candidate_root,
    policy_digest: input.connection.policy_digest,
    target_operations: merge.target_operations,
    incoming_artifacts: merge.incoming_artifacts,
  });
  if (invalid !== undefined) return failed(invalid);
  return {
    status: "ok",
    candidate: {
      tree_oid: prepared.tree_oid,
      merge,
      candidate_root: prepared.candidate_root,
    },
  };
}

async function rereadControl(
  deps: IntegrationDeps,
  input: { readonly project_id: string; readonly connection: CollaborationConnectionRecord },
): Promise<ControlSnapshot | CollaborationFailure> {
  const state = await deps.controlStore.readControl({
    project_id: input.project_id,
    control_ref: deps.control_ref,
    target_ref: input.connection.target_ref,
  });
  if (state.status === "failed") return state.failure;
  return state.snapshot;
}

/** Seal fresh facts into a PrincipalSnapshot chained on the ref tail. */
function sealSnapshot(facts: PrincipalSnapshotFacts, chain: readonly ControlRecord[]) {
  const previous = chain[chain.length - 1];
  return buildCollaborationRecord({
    record_kind: "principal_snapshot" as const,
    control_sequence: chain.length + 1,
    ...(previous === undefined ? {} : { previous_control_record_digest: previous.record_digest }),
    snapshot_id: snapshotIdFor(facts.principal_id, facts.repository_id, facts.observed_at),
    principal_id: facts.principal_id,
    provider: facts.provider,
    host: facts.host,
    subject_id: facts.subject_id,
    repository_id: facts.repository_id,
    permission: facts.permission,
    observed_at: facts.observed_at,
    expires_at: facts.expires_at,
    source_response_digest: facts.source_response_digest,
  });
}

/**
 * The liveness gate prepare and accept both apply to the Integration Lease
 * chain tip: a released/revoked tip retires its fencing token permanently, an
 * expired tip is retryable through a fresh prepare, and a fencing-token
 * mismatch means the caller's epoch was fenced by a newer one. Returns the
 * failure to report, or undefined while the tip is live.
 */
function assertLiveLeaseTip(
  tip: LeaseRecord,
  now: string,
  fencingToken?: number,
): CollaborationFailure | undefined {
  if (tip.state === "released" || tip.state === "revoked") {
    return collaborationFailure(
      "lease_fenced",
      `integration lease ${tip.lease_id} is ${tip.state}; its fencing token is permanently retired`,
    );
  }
  if (tip.state === "expired" || tip.expires_at <= now) {
    return collaborationFailure(
      "lease_expired",
      `integration lease ${tip.lease_id} expired at ${tip.expires_at}; re-run prepare_integration`,
      true,
    );
  }
  if (fencingToken !== undefined && tip.fencing_token !== fencingToken) {
    return collaborationFailure(
      "lease_fenced",
      `fencing token ${fencingToken} is stale; the live integration lease holds token ${tip.fencing_token}`,
    );
  }
  return undefined;
}

type IntegrationLeaseAcquisition =
  | {
      readonly status: "acquired";
      readonly lease: LeaseRecord;
      /** Control Ref records appended while acquiring (snapshot, lease). */
      readonly appended: readonly ControlRecord[];
    }
  | { readonly status: "cas_lost" }
  | { readonly status: "failed"; readonly failure: CollaborationFailure };

/**
 * Fetch and validate the Integration Lease for one prepare attempt (design
 * §14.1.1): seal the actor's fresh PrincipalSnapshot when the chain does not
 * carry it yet, run the acquire transition until the lease record stands on
 * the chain, then require the command's lease to still hold the resource at
 * the live tip. `cas_lost` asks the caller to re-read and re-decide.
 */
async function acquireIntegrationLease(
  deps: IntegrationDeps,
  input: {
    readonly project_id: string;
    readonly command_id: string;
    readonly control: ControlSnapshot;
    readonly session: CollaborationSession;
    readonly snapshot_facts: PrincipalSnapshotFacts;
  },
): Promise<IntegrationLeaseAcquisition> {
  let chain: ControlRecord[] = [...input.control.control_records];
  let headOid = input.control.control_head_oid;
  const appended: ControlRecord[] = [];

  // Bind the lease to the actor's fresh snapshot; seal it when the chain
  // does not carry it yet (a retry after a lost response reuses it).
  const snapshotId = snapshotIdFor(
    input.snapshot_facts.principal_id,
    input.snapshot_facts.repository_id,
    input.snapshot_facts.observed_at,
  );
  let snapshot = chain.find(
    (record): record is PrincipalSnapshotRecord =>
      record.record_kind === "principal_snapshot" &&
      (record as PrincipalSnapshotRecord).snapshot_id === snapshotId,
  );
  if (snapshot === undefined) {
    const sealed = sealSnapshot(input.snapshot_facts, chain);
    const appendedSnapshot = await deps.controlStore.appendControl({
      project_id: input.project_id,
      control_ref: deps.control_ref,
      ...(headOid === undefined ? {} : { expected_head_oid: headOid }),
      record: sealed,
    });
    if (appendedSnapshot.status === "failed") {
      if (appendedSnapshot.failure.code === "control_ref_cas_failed") {
        return { status: "cas_lost" };
      }
      return { status: "failed", failure: appendedSnapshot.failure };
    }
    headOid = appendedSnapshot.head_oid;
    chain = [...chain, sealed];
    appended.push(sealed);
    snapshot = sealed;
  }

  const acquire = {
    resource_kind: "integration" as const,
    resource_id: input.project_id,
    command_id: input.command_id,
  };
  let transition = transitionAcquireLease(
    integrationLeaseHistory(chain, input.project_id),
    acquire,
    deps.now(),
  );
  while (transition.kind === "draft") {
    const record = sealLeaseRecord(
      transition.draft,
      chain,
      snapshot.record_digest,
      input.session.client_instance_id,
    );
    const appendedLease = await deps.controlStore.appendControl({
      project_id: input.project_id,
      control_ref: deps.control_ref,
      ...(headOid === undefined ? {} : { expected_head_oid: headOid }),
      record,
    });
    if (appendedLease.status === "failed") {
      if (appendedLease.failure.code === "control_ref_cas_failed") {
        return { status: "cas_lost" };
      }
      return { status: "failed", failure: appendedLease.failure };
    }
    headOid = appendedLease.head_oid;
    chain = [...chain, record];
    appended.push(record);
    transition = transitionAcquireLease(
      integrationLeaseHistory(chain, input.project_id),
      acquire,
      deps.now(),
    );
  }
  if (transition.kind === "rejected") return { status: "failed", failure: transition.failure };
  if (transition.kind !== "existing") {
    return {
      status: "failed",
      failure: collaborationFailure(
        "coordinator_unavailable",
        "integration lease transition ended in an unexpected draft state",
      ),
    };
  }
  const lease = transition.record;

  // A replayed lease record is only usable while it still holds the resource
  // on the chain tip.
  const tip = integrationLeaseHistory(chain, input.project_id).at(-1);
  if (tip === undefined || tip.lease_id !== lease.lease_id) {
    return {
      status: "failed",
      failure: collaborationFailure(
        "lease_fenced",
        "the integration lease recorded for this command no longer holds the resource",
      ),
    };
  }
  const unlive = assertLiveLeaseTip(tip, deps.now());
  if (unlive !== undefined) return { status: "failed", failure: unlive };
  return { status: "acquired", lease, appended };
}

export async function prepareIntegration(
  deps: IntegrationDeps,
  input: PrepareIntegrationInput,
): Promise<PrepareIntegrationResult> {
  const integrationId = integrationIdFor(input.operation_commit, input.expected_target_commit);

  // A lost Control Ref CAS loops once through a fresh read and a semantic
  // re-decision, mirroring the lease slice; a second loss is lease_unavailable.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const control = attempt === 0 ? input.control : await rereadControl(deps, input);
    if (!("control_records" in control)) return failed(control);

    const acquired = await acquireIntegrationLease(deps, {
      project_id: input.project_id,
      command_id: input.command_id,
      control,
      session: input.session,
      snapshot_facts: input.snapshot_facts,
    });
    if (acquired.status === "cas_lost") continue;
    if (acquired.status === "failed") return failed(acquired.failure);
    const lease = acquired.lease;
    const appended = acquired.appended;

    // Idempotent replay: the same command already staged this candidate.
    // Re-run the deterministic verification before answering, so a candidate
    // that only staged because an earlier attempt crashed mid-validation can
    // never replay as prepared.
    const staged = await deps.controlStore.readCandidate({
      project_id: input.project_id,
      integration_id: integrationId,
    });
    if (staged.status === "failed") return failed(staged.failure);
    if (staged.status === "found" && staged.record.command_id === input.command_id) {
      const verified = await recomputeAndValidate(deps, {
        project_id: input.project_id,
        operation_id: input.operation_id,
        connection: input.connection,
        record: staged.record,
        staged_tree_oid: staged.tree_oid,
      });
      if (verified.status === "failed") return failed(verified.failure);
      return {
        status: "prepared",
        integration_record: staged.record,
        candidate_commit: staged.candidate_commit,
        appended: [],
        replayed: true,
      };
    }

    let observed: CandidateMergeView | undefined;
    let planRecord: IntegrationRecord | undefined;
    const prepared = await deps.controlStore.prepareCandidate({
      project_id: input.project_id,
      operation_id: input.operation_id,
      target_ref: input.connection.target_ref,
      expected_target_commit: input.expected_target_commit,
      operation_commit: input.operation_commit,
      plan: (merge) => {
        observed = merge;
        const plan = planIntegrationCandidate({
          integration_id: integrationId,
          project_id: input.project_id,
          operation_id: input.operation_id,
          expected_target_commit: input.expected_target_commit,
          operation_commit: input.operation_commit,
          lease_fencing_token: lease.fencing_token,
          command_id: input.command_id,
          merge,
        });
        if (plan.status === "planned") planRecord = plan.record;
        return plan;
      },
    });
    if (prepared.status === "failed") return failed(prepared.failure);
    if (observed === undefined || planRecord === undefined) {
      return failed(
        collaborationFailure(
          "coordinator_unavailable",
          "candidate preparation produced no plan record",
        ),
      );
    }
    const merge = observed as CandidateMergeView;
    const record = planRecord as IntegrationRecord;
    const invalid = validateCandidateTree({
      candidate_root: prepared.candidate_root,
      policy_digest: input.connection.policy_digest,
      target_operations: merge.target_operations,
      incoming_artifacts: merge.incoming_artifacts,
    });
    if (invalid !== undefined) return failed(invalid);
    return {
      status: "prepared",
      integration_record: record,
      candidate_commit: prepared.candidate_commit,
      appended,
      replayed: false,
    };
  }
  return failed(
    collaborationFailure(
      "lease_unavailable",
      "control ref compare-and-swap was lost twice; re-read and retry the prepare command",
      true,
    ),
  );
}

/** Best-effort release of the held Integration Lease after the CAS landed. */
async function releaseIntegrationLease(
  deps: IntegrationDeps,
  input: AcceptIntegrationInput,
  tip: LeaseRecord,
): Promise<LeaseRecord | undefined> {
  const transition = transitionLease(
    integrationLeaseHistory(input.control.control_records, input.project_id),
    {
      kind: "release_operation_lease",
      command_id: `${input.command_id}-release`,
      project_id: input.project_id,
      lease_id: tip.lease_id,
    },
    deps.now(),
  );
  if (transition.kind !== "draft") return undefined;
  const record = sealLeaseRecord(
    transition.draft,
    input.control.control_records,
    tip.holder_principal_snapshot_digest,
    input.session.client_instance_id,
  );
  const appended = await deps.controlStore.appendControl({
    project_id: input.project_id,
    control_ref: deps.control_ref,
    ...(input.control.control_head_oid === undefined
      ? {}
      : { expected_head_oid: input.control.control_head_oid }),
    record,
  });
  return appended.status === "appended" ? record : undefined;
}

export async function acceptIntegration(
  deps: IntegrationDeps,
  input: AcceptIntegrationInput,
): Promise<AcceptIntegrationResult> {
  // 1. The staged candidate is the only source of the prepared record.
  const staged = await deps.controlStore.readCandidate({
    project_id: input.project_id,
    integration_id: input.integration_id,
  });
  if (staged.status === "failed") return failed(staged.failure);
  if (staged.status === "missing") {
    // A landed swap cleans the staging ref up, so a retry after a lost
    // response may find no staged candidate; recover the accepted fact from
    // the Target history before declaring the candidate missing. The stored
    // record is digest-validated on read, and the integration id plus the
    // command's frozen expected commit pin the identity of the accept.
    const recovered = await deps.controlStore.readIntegrationRecord({
      project_id: input.project_id,
      target_ref: input.connection.target_ref,
      integration_id: input.integration_id,
    });
    if (recovered.status === "failed") return failed(recovered.failure);
    if (recovered.status === "found") {
      if (recovered.record.expected_target_commit === input.expected_target_commit) {
        return {
          status: "accepted",
          integration_record: recovered.record,
          target_commit: recovered.commit,
          appended: [],
          replayed: true,
        };
      }
      return failed(
        collaborationFailure(
          "target_cas_failed",
          "the target history carries a conflicting record for this integration id; never replay an old accept",
        ),
      );
    }
    return failed(
      collaborationFailure(
        "coordinator_unavailable",
        `no staged candidate for integration ${input.integration_id}; run prepare_integration first`,
        true,
      ),
    );
  }
  const record = staged.record;
  if (record.expected_target_commit !== input.expected_target_commit) {
    return failed(
      collaborationFailure(
        "baseline_drift",
        "the command's expected target commit differs from the prepared record; re-read the target and re-prepare",
      ),
    );
  }

  // 2. Lost-response recovery, checked before the Lease: a completed accept
  //    released its Lease, so a legitimate retry would otherwise fence itself.
  //    The Target history may already carry this exact accepted record
  //    (design §14.4). The match is integration id plus record digest: the
  //    digest canonically covers the record's command id and every frozen
  //    field, so a digest match is the strongest possible identity check; a
  //    retried accept command never re-derives the record.
  const existing = await deps.controlStore.readIntegrationRecord({
    project_id: input.project_id,
    target_ref: input.connection.target_ref,
    integration_id: input.integration_id,
  });
  if (existing.status === "failed") return failed(existing.failure);
  if (existing.status === "found") {
    if (existing.record.record_digest === record.record_digest) {
      return {
        status: "accepted",
        integration_record: existing.record,
        target_commit: existing.commit,
        appended: [],
        replayed: true,
      };
    }
    return failed(
      collaborationFailure(
        "target_cas_failed",
        "the target history carries a conflicting record for this integration id; never replay an old accept",
      ),
    );
  }

  // 3. The Integration Lease and its fencing token must still be live.
  const history = integrationLeaseHistory(input.control.control_records, input.project_id);
  const tip = history[history.length - 1];
  if (tip === undefined) {
    return failed(
      collaborationFailure(
        "lease_fenced",
        "no integration lease exists for this project; re-run prepare_integration",
      ),
    );
  }
  const unlive = assertLiveLeaseTip(tip, deps.now(), record.lease_fencing_token);
  if (unlive !== undefined) return failed(unlive);

  // 3b. The Target head moved after prepare and the move is not this
  //     integration: the frozen expected commit is stale (spec §15.1). The
  //     candidate stays staged; the caller re-reads and re-prepares.
  if (
    input.control.target_head_oid !== undefined &&
    input.control.target_head_oid !== record.expected_target_commit
  ) {
    return failed(
      collaborationFailure(
        "target_cas_failed",
        "target head moved since the candidate was prepared; re-read the target and re-prepare",
        true,
      ),
    );
  }

  // 4. Deterministic recomputation: merge + resequence + fixed record path
  //    must reproduce the staged record and tree (design §14.3).
  const verified = await recomputeAndValidate(deps, {
    project_id: input.project_id,
    operation_id: record.operation_id,
    connection: input.connection,
    record,
    staged_tree_oid: staged.tree_oid,
  });
  if (verified.status === "failed") return failed(verified.failure);

  // 5. Target CAS with force-with-lease semantics against the frozen OID;
  //    CAS success is the final acceptance fact.
  const cas = await deps.controlStore.compareAndSwapTarget({
    project_id: input.project_id,
    target_ref: input.connection.target_ref,
    expected_commit: record.expected_target_commit,
    new_commit: staged.candidate_commit,
    integration_id: input.integration_id,
  });
  if (cas.status === "failed") {
    if (cas.failure.code === "target_cas_failed" || cas.failure.code === "git_remote_unavailable") {
      // The swap may have landed while the response was lost; recover from
      // the Target history, never blindly retry the accept.
      const recovered = await deps.controlStore.readIntegrationRecord({
        project_id: input.project_id,
        target_ref: input.connection.target_ref,
        integration_id: input.integration_id,
      });
      if (recovered.status === "found" && recovered.record.record_digest === record.record_digest) {
        const released = await releaseIntegrationLease(deps, input, tip);
        return {
          status: "accepted",
          integration_record: recovered.record,
          target_commit: recovered.commit,
          appended: released === undefined ? [] : [released],
          replayed: true,
        };
      }
    }
    return failed(cas.failure);
  }

  const released = await releaseIntegrationLease(deps, input, tip);
  return {
    status: "accepted",
    integration_record: record,
    target_commit: cas.commit,
    appended: released === undefined ? [] : [released],
    replayed: false,
  };
}
