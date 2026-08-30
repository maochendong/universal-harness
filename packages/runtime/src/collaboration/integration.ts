import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  resolveHarnessPath,
  sha256Hex,
  shardMonthFor,
  validateSchema,
  type CollaborationConnectionRecord,
  type CommittedOperation,
  type ControlRecord,
  type EdgeRecord,
  type IntegrationRecord,
  type LeaseRecord,
  type LedgerOperation,
  type NodeRecord,
  type PrincipalSnapshotRecord,
  type ReplayResult,
} from "@universal-harness-internal/core";
import {
  ImpactError,
  RISK_LEVELS,
  assertApprovedImpactSet,
  generateImpactSet,
  materializeLedger,
  readImpactSetContent,
  type ImpactSetContent,
} from "@universal-harness-internal/graph";

import { bindingDrift } from "../approval/invalidation.js";
import type { ApprovalRequestRecord } from "../approval/request.js";
import {
  readGateEvidenceExtension,
  type GateEvidenceExtension,
  type GateEvidenceRecord,
} from "../gates/evidence.js";
import { evidenceStalenessReasons } from "../gates/freshness.js";
import { readExecutionPlanContent } from "../planning/execution-plan.js";
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
 * Validation scope (design §14.1 step 7): every dimension of the authority
 * chain that is addressable from the candidate tree is recomputed on it —
 * never replayed verbatim:
 *
 * - Impact: a frozen ImpactSet embeds its planning seeds and entries, so the
 *   Coordinator re-runs `generateImpactSet` for the set the branch's current
 *   ExecutionPlan pins over the reconstructed baseline graph (all Target-side
 *   operations plus the incoming operations up to the freeze). Clean Target
 *   drift that widens the blast radius of the approved seeds — new reachable
 *   nodes, stronger classifications, higher risk — flips the recomputation
 *   and rejects the candidate with `baseline_drift`. Advisory-merged entries
 *   (`seed_id === "advisory"`) are not re-derivable by construction, so the
 *   comparison is entry-wise: deterministic entries must reproduce exactly,
 *   advisory entries are trusted as approved, and any recomputed entry absent
 *   from the frozen set is drift.
 * - Evidence freshness: the code digest (`hashWorktreeCode` over the
 *   candidate worktree) and the policy digest (the connection's) are
 *   recomputed directly. Every other bound digest (artifact set, context
 *   bundle, evaluation cases) is a content digest of a Ledger artifact, so it
 *   is re-resolved against the candidate's materialized artifact store: a
 *   bound digest no vouched candidate artifact carries makes the evidence
 *   stale (`integration_gate_failed`). The gate definition digest is the one
 *   dimension with no tree addressing: gate definitions are Coordinator
 *   configuration (`createDefaultGateSuite` / `deps.gates`,
 *   kernel-coordinator.ts), never Ledger records, so nothing in the tree can
 *   reproduce the digest; the replica's own Snapshot completion rules
 *   re-check it (`completionBlockers` with `currentFor`) once the accepted
 *   Target syncs back.
 * - Approval bindings: policy is recomputed from the connection; an
 *   ImpactSet object binding is re-verified against the candidate graph with
 *   the planning guard itself (`assertApprovedImpactSet`); any other object
 *   or baseline digest must resolve to a Ledger-vouched candidate artifact.
 *   `impact_path` stays bound-as-minted: the only request-minting call site
 *   (orchestration/approval-runtime.ts) always binds `[]`, and the local
 *   ApprovalService itself has no recomputation oracle for it
 *   (`currentBinding` echoes the request when no `readBinding` is injected),
 *   so there is nothing to recompute against.
 *
 * Anything the candidate cannot disprove fails closed with a typed §16 error.
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
  readonly object_id: string;
  readonly object_type: string;
  readonly object_digest: string;
  readonly baseline_digest: string;
  readonly policy_digest: string;
  readonly impact_path: readonly string[];
}

function approvalRequestShapeOf(parsed: Record<string, unknown>): ApprovalRequestShape | undefined {
  const candidate = parsed as Partial<ApprovalRequestShape>;
  if (
    typeof candidate.request_id !== "string" ||
    typeof candidate.object_id !== "string" ||
    typeof candidate.object_type !== "string" ||
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

// --- Candidate materialized state (design §14.1 step 7 revalidation) -------

const HEX_DIGEST = /^[a-f0-9]{64}$/u;

/**
 * The candidate's Ledger-vouched artifact store, indexed for binding
 * revalidation: which committed operation vouches each artifact, the content
 * digests those artifacts provably carry, and the parsed graph nodes.
 */
interface CandidateLedgerState {
  /** Candidate operations in replay order (Target history + incoming + final). */
  readonly operations: readonly CommittedOperation[];
  /** Candidate operations the accepted Target history does not contain. */
  readonly incoming: readonly CommittedOperation[];
  /**
   * Every digest a vouched candidate artifact provably commits to: the file's
   * own sha256, its top-level `digest`/`content_digest`/`record_digest`, and
   * (for node records) the `content_digest` of each extension payload.
   */
  readonly digestUniverse: ReadonlySet<string>;
  /** Parsed vouched node artifacts, keyed by artifact file sha256. */
  readonly nodesByDigest: ReadonlyMap<string, NodeRecord>;
  /** Artifact file sha256 -> ids of the candidate operations vouching it. */
  readonly vouchers: ReadonlyMap<string, readonly string[]>;
}

function listArtifactPaths(artifactsRoot: string): string[] {
  if (!existsSync(artifactsRoot)) return [];
  const results: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) results.push(absolute);
    }
  };
  walk(artifactsRoot);
  return results.sort();
}

function candidateLedgerState(
  candidateRoot: string,
  replay: ReplayResult,
  targetOperations: readonly LedgerOperation[],
): CandidateLedgerState {
  const targetIds = new Set(targetOperations.map((manifest) => manifest.ledger_operation_id));
  const incoming = replay.operations.filter(
    (operation) => !targetIds.has(operation.manifest.ledger_operation_id),
  );
  const vouchers = new Map<string, string[]>();
  for (const operation of replay.operations) {
    for (const digest of operation.manifest.artifact_digests) {
      const list = vouchers.get(digest) ?? [];
      list.push(operation.manifest.ledger_operation_id);
      vouchers.set(digest, list);
    }
  }
  const digestUniverse = new Set<string>();
  const nodesByDigest = new Map<string, NodeRecord>();
  const artifactsRoot = resolveHarnessPath(harnessRootFor(candidateRoot), "artifacts");
  for (const absolute of listArtifactPaths(artifactsRoot)) {
    const content = readFileSync(absolute, "utf8");
    const digest = sha256Hex(content);
    // Orphan bytes no committed manifest vouches for are not authoritative.
    if (!vouchers.has(digest)) continue;
    digestUniverse.add(digest);
    const parsed = parseArtifact(content);
    if (parsed === undefined) continue;
    for (const key of ["digest", "content_digest", "record_digest"] as const) {
      const value = parsed[key];
      if (typeof value === "string" && HEX_DIGEST.test(value)) digestUniverse.add(value);
    }
    if (parsed.record_kind !== "node") continue;
    // Graph reconcile above already schema-validated every vouched node.
    const node = parsed as unknown as NodeRecord;
    nodesByDigest.set(digest, node);
    for (const extension of Object.values(node.extensions ?? {})) {
      if (typeof extension !== "object" || extension === null) continue;
      const extensionDigest = (extension as { content_digest?: unknown }).content_digest;
      if (typeof extensionDigest === "string" && HEX_DIGEST.test(extensionDigest)) {
        digestUniverse.add(extensionDigest);
      }
    }
  }
  return { operations: replay.operations, incoming, digestUniverse, nodesByDigest, vouchers };
}

/**
 * Edge records of one candidate operation's shard. `replayLedger` already
 * verified the shard bytes against the manifest digest, so this only parses.
 */
function operationEdges(harnessRoot: string, operation: CommittedOperation): EdgeRecord[] {
  const content = readFileSync(
    resolveHarnessPath(harnessRoot, operation.manifest.edge_file),
    "utf8",
  );
  return content
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as EdgeRecord);
}

interface FrozenImpactSet {
  readonly node: NodeRecord;
  readonly content: ImpactSetContent;
  /** Candidate sequence of the latest incoming operation vouching the frozen revision. */
  readonly frozenAtSequence: number;
}

/**
 * Entry-wise drift between a frozen ImpactSet and its recomputation on the
 * candidate baseline. Advisory-merged entries (`seed_id === "advisory"`) are
 * approved facts the deterministic engine cannot re-derive, so they are
 * trusted; every deterministic entry must reproduce, and any recomputed entry
 * the frozen set does not cover — or covers at a weaker classification or
 * lower risk — is drift the approval never saw.
 */
function impactEntryDrift(
  frozen: ImpactSetContent,
  recomputed: ImpactSetContent,
): readonly string[] {
  const frozenByNode = new Map(frozen.entries.map((entry) => [entry.node_id, entry] as const));
  const recomputedNodes = new Set(recomputed.entries.map((entry) => entry.node_id));
  const drift: string[] = [];
  for (const entry of recomputed.entries) {
    const approved = frozenByNode.get(entry.node_id);
    if (approved === undefined) {
      drift.push(
        `node ${entry.node_id} is reachable from the approved seeds but the frozen set does not cover it`,
      );
      continue;
    }
    if (approved.classification !== entry.classification) {
      drift.push(
        `node ${entry.node_id} reclassifies ${approved.classification} -> ${entry.classification}`,
      );
      continue;
    }
    if (RISK_LEVELS.indexOf(entry.risk) > RISK_LEVELS.indexOf(approved.risk)) {
      drift.push(`node ${entry.node_id} risk rises ${approved.risk} -> ${entry.risk}`);
    }
  }
  for (const entry of frozen.entries) {
    if (entry.seed_id === "advisory") continue;
    if (!recomputedNodes.has(entry.node_id)) {
      drift.push(
        `approved entry ${entry.node_id} is no longer reproducible on the candidate baseline`,
      );
    }
  }
  return drift;
}

/**
 * Impact revalidation (design §14.1 step 7): re-run the approved seeds of the
 * ImpactSet the branch's current ExecutionPlan pins over the reconstructed
 * baseline graph — every Target-side operation plus the incoming operations
 * up to the freeze. The merge is append-only on the Target side, so the
 * recomputation differs from the frozen entries exactly when clean Target
 * drift widened the blast radius the approval covered.
 */
function validateCandidateImpact(
  harnessRoot: string,
  state: CandidateLedgerState,
): CollaborationFailure | undefined {
  const incomingIds = new Set(
    state.incoming.map((operation) => operation.manifest.ledger_operation_id),
  );
  const sequenceOf = new Map(
    state.operations.map(
      (operation) => [operation.manifest.ledger_operation_id, operation.manifest.sequence] as const,
    ),
  );

  // Frozen (approved) ImpactSets carried by the incoming branch, grouped by
  // iteration; Target-side sets were revalidated by their own integrations.
  const byIteration = new Map<string, FrozenImpactSet[]>();
  for (const [digest, node] of state.nodesByDigest) {
    if (node.type !== "ImpactSet" || node.status !== "accepted") continue;
    let content: ImpactSetContent;
    try {
      content = readImpactSetContent(node);
    } catch (error) {
      return collaborationFailure(
        "baseline_drift",
        `impact set ${node.id} carried by the candidate is unreadable: ${errorMessage(error)}`,
      );
    }
    if (content.approval_digest === undefined) continue; // proposed, never frozen
    const vouching = (state.vouchers.get(digest) ?? []).filter((id) => incomingIds.has(id));
    if (vouching.length === 0) continue; // accepted Target history
    const frozenAtSequence = Math.max(...vouching.map((id) => sequenceOf.get(id) as number));
    const group = byIteration.get(node.provenance.iteration_id) ?? [];
    group.push({ node, content, frozenAtSequence });
    byIteration.set(node.provenance.iteration_id, group);
  }

  for (const [iterationId, sets] of byIteration) {
    // The set the branch's current plan pins is authoritative; superseded
    // sets are history and must not fail the candidate. The selection mirrors
    // loadPlan: highest revision first.
    const plans = [...state.nodesByDigest.values()]
      .filter(
        (node) => node.type === "ExecutionPlan" && node.provenance.iteration_id === iterationId,
      )
      .sort((left, right) => right.revision - left.revision);
    let selected: FrozenImpactSet;
    if (plans.length > 0) {
      let pinnedId: string;
      let pinnedDigest: string;
      try {
        const planContent = readExecutionPlanContent(plans[0] as NodeRecord);
        pinnedId = planContent.impact_set_id;
        pinnedDigest = planContent.impact_set_digest;
      } catch (error) {
        return collaborationFailure(
          "baseline_drift",
          `the candidate's current execution plan for iteration ${iterationId} is unreadable: ${errorMessage(error)}`,
        );
      }
      const pinned = sets.find((entry) => entry.node.id === pinnedId);
      if (pinned === undefined) {
        return collaborationFailure(
          "baseline_drift",
          `the current plan of iteration ${iterationId} pins impact set ${pinnedId}, which the candidate does not carry as a frozen, approved set`,
        );
      }
      if (pinned.content.content_digest !== pinnedDigest) {
        return collaborationFailure(
          "baseline_drift",
          `the current plan of iteration ${iterationId} pins impact digest ${pinnedDigest} but the frozen set digests to ${pinned.content.content_digest}`,
        );
      }
      selected = pinned;
    } else {
      selected = sets.reduce((latest, entry) =>
        entry.frozenAtSequence > latest.frozenAtSequence ? entry : latest,
      );
    }

    const graphOperationIds = new Set(
      state.operations
        .filter(
          (operation) =>
            !incomingIds.has(operation.manifest.ledger_operation_id) ||
            operation.manifest.sequence <= selected.frozenAtSequence,
        )
        .map((operation) => operation.manifest.ledger_operation_id),
    );
    const nodesById = new Map<string, NodeRecord>();
    for (const [digest, node] of state.nodesByDigest) {
      if (!(state.vouchers.get(digest) ?? []).some((id) => graphOperationIds.has(id))) continue;
      const current = nodesById.get(node.id);
      if (current === undefined || node.revision > current.revision) nodesById.set(node.id, node);
    }
    const edgesById = new Map<string, EdgeRecord>();
    for (const operation of state.operations) {
      if (!graphOperationIds.has(operation.manifest.ledger_operation_id)) continue;
      for (const edge of operationEdges(harnessRoot, operation)) {
        edgesById.set(edge.id, edge);
      }
    }
    let recomputed: ImpactSetContent;
    try {
      recomputed = readImpactSetContent(
        generateImpactSet(
          selected.content.seeds,
          [...nodesById.values()],
          [...edgesById.values()],
          {
            iterationId,
            actor: "integration-recheck",
            timestamp: selected.node.provenance.timestamp,
          },
        ),
      );
    } catch (error) {
      if (error instanceof ImpactError) {
        return collaborationFailure(
          "baseline_drift",
          `the approved impact seeds of ${selected.node.id} no longer resolve on the merged target baseline: ${error.message}`,
        );
      }
      throw error;
    }
    const drift = impactEntryDrift(selected.content, recomputed);
    if (drift.length > 0) {
      return collaborationFailure(
        "baseline_drift",
        `frozen impact set ${selected.node.id} no longer covers the merged target baseline: ${drift.join("; ")}`,
      );
    }
  }
  return undefined;
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

  // The candidate's vouched artifact store and graph, indexed once for the
  // Impact, Evidence and Approval revalidation below.
  const state = candidateLedgerState(input.candidate_root, replay, input.target_operations);

  // Impact: re-run the approved seeds of the plan-pinned frozen ImpactSet
  // over the reconstructed baseline graph (design §14.1 step 7).
  const impactFailure = validateCandidateImpact(harnessRoot, state);
  if (impactFailure !== undefined) return impactFailure;

  // Mandatory Gate evidence carried by the incoming branch. The code binding
  // is recomputable here: the candidate root is a Git worktree, so its code
  // digest is recomputed exactly the way the replica binds it (any code the
  // merge added beyond what the evidence covered makes the binding stale).
  // Every other bound digest is a Ledger artifact content digest and is
  // re-resolved against the candidate's vouched artifact store; the gate
  // definition digest is the only dimension with no tree addressing (see the
  // module header).
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
    // Recompute the artifact bindings against the candidate's vouched store:
    // a bound digest no committed candidate operation carries can never be
    // resurrected by the merge, so the evidence is stale on the candidate.
    const unresolvable = [
      ...extension.bindings.artifact_digests.filter((digest) => !state.digestUniverse.has(digest)),
      ...extension.bindings.evaluation_case_digests.filter(
        (digest) => !state.digestUniverse.has(digest),
      ),
      ...(extension.bindings.context_bundle_digest !== undefined &&
      !state.digestUniverse.has(extension.bindings.context_bundle_digest)
        ? [extension.bindings.context_bundle_digest]
        : []),
    ];
    if (unresolvable.length > 0) {
      return collaborationFailure(
        "integration_gate_failed",
        `${gate} binds digests no vouched candidate artifact carries: ${unresolvable.join(", ")}`,
      );
    }
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
    // The policy digest recomputes from the connection; object, baseline and
    // impact path are re-resolved against the candidate's materialized state
    // below (the module header documents the impact_path scope).
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
    if (request.object_type === "ImpactSet") {
      // Re-verify the binding with the planning guard itself: the bound
      // revision must be the candidate's latest for its id, still frozen and
      // still digesting to exactly what was approved.
      const bound = [...state.nodesByDigest.values()]
        .filter((node) => node.id === request.object_id && node.type === "ImpactSet")
        .sort((left, right) => right.revision - left.revision)[0];
      try {
        if (bound === undefined) {
          throw new ImpactError(`no ImpactSet node ${request.object_id} in the candidate graph`);
        }
        assertApprovedImpactSet(bound, request.object_digest);
      } catch (error) {
        return collaborationFailure(
          "approval_binding_mismatch",
          `approval request ${request.request_id} binds impact set ${request.object_id} at ${request.object_digest}, which does not verify on the candidate: ${errorMessage(error)}`,
        );
      }
    } else if (!state.digestUniverse.has(request.object_digest)) {
      return collaborationFailure(
        "approval_binding_mismatch",
        `approval request ${request.request_id} binds object_digest ${request.object_digest}, which no vouched candidate artifact carries; re-issue it against current bindings`,
      );
    }
    if (!state.digestUniverse.has(request.baseline_digest)) {
      return collaborationFailure(
        "approval_binding_mismatch",
        `approval request ${request.request_id} binds baseline_digest ${request.baseline_digest}, which no vouched candidate artifact carries; re-issue it against current bindings`,
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
