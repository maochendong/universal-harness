import {
  harnessRootFor,
  PROTOCOL_1_2_VERSION,
  sha256Hex,
  ulid,
  type CommitHooks,
  type LockTuning,
} from "@universal-harness-internal/core";

import {
  WorkflowEngine,
  ledgerRepositoryFor,
  type WorkflowDependencies,
  type WorkflowIdKind,
} from "../workflow/operation.js";
import {
  ApprovalError,
  approvalDecisionArtifact,
  approvalRequestArtifact,
  buildApprovalDecision,
  buildApprovalRequest,
  proposedByOf,
  readApprovalDecisions,
  readPendingApprovalRequests,
  readApprovalRequests,
  remoteDecisionDigestOf,
  type ApprovalDecision,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type ApprovalRisk,
} from "./request.js";
import {
  approvalRequiredOutcome,
  promptForApprovalDecision,
  resumeCommandFor,
  type ApprovalPrompter,
  type ApprovalRequiredOutcome,
} from "./interaction.js";
import { bindingDrift, reissueRequestSpec, type ApprovalBindingSnapshot } from "./invalidation.js";
import { remoteApprovalMaterializedEvent } from "../orchestration/lifecycle-events.js";

/**
 * Approval service (design 11.3). Every approval point persists the
 * ApprovalRequest and a checkpoint in one ledger operation before any human
 * input is awaited. Decisions are explicit only, resolve one exact
 * request/object/digest at a time, revalidate every binding at commit time,
 * and never allow the proposing agent, tool or adapter to resolve its own
 * request.
 */
export type ApprovalIdKind = WorkflowIdKind | "approval_request" | "approval_decision";

export interface ApprovalDependencies {
  readonly projectRoot: string;
  /** Current Git baseline (HEAD) the next ledger commit must build on. */
  readonly readBaseline: () => string;
  /** Injectable clock (ISO 8601 UTC) for deterministic tests. */
  readonly now?: () => string;
  /** Injectable id mint for deterministic tests; defaults to ULID-based ids. */
  readonly newId?: (kind: ApprovalIdKind) => string;
  /** Commit hooks for durable-boundary fault injection. */
  readonly hooks?: CommitHooks;
  readonly lock?: LockTuning;
  /**
   * Recomputes the digests a request bound at creation time. Decision commit
   * and resume revalidate against this snapshot; any drift invalidates the
   * request and re-issues it.
   */
  readonly readBinding?: (request: ApprovalRequestRecord) => ApprovalBindingSnapshot;
}

export interface RequestApprovalInput {
  readonly workflowOperationId: string;
  readonly objectId: string;
  readonly objectType: string;
  readonly objectDigest: string;
  readonly baselineDigest: string;
  readonly policyDigest: string;
  readonly impactPath: readonly string[];
  readonly risk: ApprovalRisk;
  readonly reason: string;
  readonly allowedDecisions?: readonly ApprovalDecision[];
  readonly resumePhase: string;
  /** Actor whose proposal is under approval; may never resolve the request. */
  readonly proposedBy: string;
  /**
   * First-class requester Principal binding for remote approval (design §9.3);
   * required for any request a remote session may decide.
   */
  readonly requesterPrincipal?: {
    readonly principal_id: string;
    readonly principal_snapshot_digest: string;
  };
}

export interface ResolveDecisionInput {
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  /** Exact digest of the controlled object; a mismatch is never approved. */
  readonly objectDigest: string;
  readonly actor: string;
}

/**
 * Materialization input for one authoritative RemoteApprovalDecision (design
 * §13.1). The actor is the approver's stable principal id and `decidedAt` is
 * the remote decision's own timestamp — the materialized decision is evidence
 * of a decision already made, not a new one.
 */
export interface ResolveRemoteDecisionInput {
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  /** Exact digest of the controlled object; a mismatch is never approved. */
  readonly objectDigest: string;
  readonly actor: string;
  readonly decidedAt: string;
  readonly remoteDecisionId: string;
  readonly remoteDecisionDigest: string;
}

export interface RemoteDecisionResolution {
  readonly decision: ApprovalDecisionRecord;
  /** True when the remote decision was already materialized; nothing new committed. */
  readonly replayed: boolean;
}

export type AwaitDecisionOutcome =
  | { readonly status: "deferred"; readonly required: ApprovalRequiredOutcome }
  | { readonly status: "resolved"; readonly decision: ApprovalDecisionRecord };

function nowOf(deps: ApprovalDependencies): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function newIdOf(deps: ApprovalDependencies, kind: ApprovalIdKind): string {
  return (deps.newId ?? ((idKind) => `${idKind}_${ulid()}`))(kind);
}

/**
 * Ledger pin for transactions carrying protocol 1.2 authoritative records
 * (design §19.1); absent for plain 1.0/1.1 transactions.
 */
function readerVersionPin(record: { readonly protocol_version: string }): {
  readonly requiredReaderVersion?: string;
} {
  return record.protocol_version === PROTOCOL_1_2_VERSION
    ? { requiredReaderVersion: PROTOCOL_1_2_VERSION }
    : {};
}

export class ApprovalService {
  private readonly deps: ApprovalDependencies;

  constructor(deps: ApprovalDependencies) {
    this.deps = deps;
  }

  private workflowDeps(): WorkflowDependencies {
    return {
      projectRoot: this.deps.projectRoot,
      readBaseline: this.deps.readBaseline,
      ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
      ...(this.deps.newId === undefined ? {} : { newId: this.deps.newId }),
      ...(this.deps.hooks === undefined ? {} : { hooks: this.deps.hooks }),
      ...(this.deps.lock === undefined ? {} : { lock: this.deps.lock }),
    };
  }

  private engine(): WorkflowEngine {
    return new WorkflowEngine(this.workflowDeps());
  }

  private requests(workflowOperationId: string): ApprovalRequestRecord[] {
    return readApprovalRequests(
      harnessRootFor(this.deps.projectRoot),
      ledgerRepositoryFor(this.workflowDeps()).operations(),
      workflowOperationId,
    );
  }

  /** One request by id, or `undefined` when no committed request matches. */
  getRequest(workflowOperationId: string, requestId: string): ApprovalRequestRecord | undefined {
    return this.requests(workflowOperationId).find((request) => request.request_id === requestId);
  }

  /**
   * Requests still awaiting a terminal decision, in deterministic processing
   * order. A `defer` decision keeps the request pending; a superseded or
   * terminally decided request drops out.
   */
  pendingRequests(workflowOperationId: string): ApprovalRequestRecord[] {
    return readPendingApprovalRequests(
      harnessRootFor(this.deps.projectRoot),
      ledgerRepositoryFor(this.workflowDeps()).operations(),
    ).filter((request) => request.workflow_operation_id === workflowOperationId);
  }

  /** The single next request to resolve; M1 resolves strictly one at a time. */
  nextPendingRequest(workflowOperationId: string): ApprovalRequestRecord | undefined {
    return this.pendingRequests(workflowOperationId)[0];
  }

  private requirePending(request: ApprovalRequestRecord): void {
    const pending = this.pendingRequests(request.workflow_operation_id);
    if (!pending.some((candidate) => candidate.request_id === request.request_id)) {
      throw new ApprovalError(
        "approval_not_pending",
        `approval request ${request.request_id} is already decided or superseded`,
      );
    }
  }

  /**
   * Persist the ApprovalRequest and its checkpoint in one ledger operation,
   * then block the operation as resumable. Only after this durable boundary
   * may any human input be awaited.
   */
  private async persistRequest(request: ApprovalRequestRecord): Promise<void> {
    await this.engine().commitCheckpoint(request.workflow_operation_id, {
      boundary: "approval",
      ...readerVersionPin(request),
      proposal: {
        phase: request.resume_phase,
        set_next_action: resumeCommandFor(request.workflow_operation_id),
      },
      artifacts: [approvalRequestArtifact(request)],
      events: [
        {
          eventType: "ApprovalRequired",
          payload: {
            request_id: request.request_id,
            object_id: request.object_id,
            object_type: request.object_type,
            object_digest: request.object_digest,
            risk: request.risk,
            reason: request.reason,
            proposed_by: proposedByOf(request) ?? "unknown",
          },
        },
      ],
    });
  }

  private async blockAwaitingDecision(request: ApprovalRequestRecord): Promise<void> {
    const engine = this.engine();
    const current = engine.getOperation(request.workflow_operation_id);
    if (current === undefined) return;
    if (current.state === "blocked") return;
    await engine.block(request.workflow_operation_id, {
      reason: "awaiting_approval",
      detail: `approval request ${request.request_id} awaiting a decision`,
      proposal: { set_next_action: resumeCommandFor(request.workflow_operation_id) },
    });
  }

  private buildRequest(input: RequestApprovalInput): ApprovalRequestRecord {
    return buildApprovalRequest({
      requestId: newIdOf(this.deps, "approval_request"),
      workflowOperationId: input.workflowOperationId,
      objectId: input.objectId,
      objectType: input.objectType,
      objectDigest: input.objectDigest,
      baselineDigest: input.baselineDigest,
      policyDigest: input.policyDigest,
      impactPath: input.impactPath,
      risk: input.risk,
      reason: input.reason,
      allowedDecisions: input.allowedDecisions ?? ["approve", "reject", "defer"],
      createdAt: nowOf(this.deps),
      resumePhase: input.resumePhase,
      proposedBy: input.proposedBy,
      ...(input.requesterPrincipal === undefined
        ? {}
        : { requesterPrincipal: input.requesterPrincipal }),
    });
  }

  /**
   * Non-interactive approval point: persists the request, blocks the
   * operation as resumable and returns the structured ApprovalRequired
   * outcome. It has no prompter parameter — it can never read stdin and
   * never decides implicitly.
   */
  async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequiredOutcome> {
    const request = this.buildRequest(input);
    await this.persistRequest(request);
    await this.blockAwaitingDecision(request);
    return approvalRequiredOutcome(request);
  }

  /**
   * Interactive approval point: persists first, then prompts once. Defer —
   * including Ctrl-C, EOF and unparseable input — blocks the operation and
   * keeps the proposal resumable; an explicit approve/reject resolves the
   * request immediately.
   */
  async requestApprovalInteractively(
    input: RequestApprovalInput,
    prompter: ApprovalPrompter,
    decisionActor: string,
  ): Promise<AwaitDecisionOutcome> {
    const request = this.buildRequest(input);
    await this.persistRequest(request);
    const decision = await promptForApprovalDecision(request, prompter);
    if (decision === "defer") {
      await this.blockAwaitingDecision(request);
      return { status: "deferred", required: approvalRequiredOutcome(request) };
    }
    const record = await this.resolveDecision({
      requestId: request.request_id,
      decision,
      objectDigest: request.object_digest,
      actor: decisionActor,
    });
    return { status: "resolved", decision: record };
  }

  /**
   * Commit one explicit decision for one exact request/object/digest. The
   * bindings are revalidated first; any drift appends an invalidation trail,
   * re-issues the request with current digests and refuses the stale
   * decision.
   */
  async resolveDecision(input: ResolveDecisionInput): Promise<ApprovalDecisionRecord> {
    const request = this.getRequestById(input.requestId);
    this.requirePending(request);
    if (!request.allowed_decisions.includes(input.decision)) {
      throw new ApprovalError(
        "approval_decision_not_allowed",
        `decision ${input.decision} is not allowed for request ${input.requestId}`,
      );
    }
    if (input.objectDigest !== request.object_digest) {
      throw new ApprovalError(
        "approval_binding_mismatch",
        `decision binds object digest ${input.objectDigest} but request ${input.requestId} controls ${request.object_digest}`,
      );
    }
    if (input.actor === proposedByOf(request)) {
      throw new ApprovalError(
        "approval_self_approval",
        `actor ${input.actor} may not resolve its own approval request ${input.requestId}`,
      );
    }
    const current = this.currentBinding(request);
    const drifted = bindingDrift(request, current);
    if (drifted.length > 0) {
      const reissued = await this.invalidateAndReissue(request, current, drifted);
      throw new ApprovalError(
        "approval_binding_drift",
        `approval request ${request.request_id} bindings drifted (${drifted.join(", ")}); re-issued as ${reissued.request_id}`,
        { new_request_id: reissued.request_id, changed: drifted },
      );
    }
    const record = buildApprovalDecision({
      approvalId: newIdOf(this.deps, "approval_decision"),
      requestId: request.request_id,
      actor: input.actor,
      decision: input.decision,
      objectDigest: input.objectDigest,
      decidedAt: nowOf(this.deps),
    });
    const artifact = approvalDecisionArtifact(record);
    await this.engine().commitCheckpoint(request.workflow_operation_id, {
      boundary: "approval",
      proposal: {
        add_approval_digests: [sha256Hex(artifact.content)],
        reconcile_blockers:
          record.decision === "defer"
            ? { pending_approval_ids: [request.request_id] }
            : { resolved_approval_ids: [request.request_id] },
      },
      artifacts: [artifact],
    });
    return record;
  }

  /** One request by id across workflow operations, or a typed not-found error. */
  getRequestById(requestId: string): ApprovalRequestRecord {
    const repository = ledgerRepositoryFor(this.workflowDeps());
    const harnessRoot = harnessRootFor(this.deps.projectRoot);
    const operations = repository.operations();
    const workflowOperationIds = new Set<string>();
    for (const operation of operations) {
      workflowOperationIds.add(operation.manifest.workflow_operation_id);
    }
    for (const workflowOperationId of [...workflowOperationIds].sort()) {
      const found = readApprovalRequests(harnessRoot, operations, workflowOperationId).find(
        (request) => request.request_id === requestId,
      );
      if (found !== undefined) return found;
    }
    throw new ApprovalError("approval_request_not_found", `unknown approval request: ${requestId}`);
  }

  private decisions(workflowOperationId: string): ApprovalDecisionRecord[] {
    return readApprovalDecisions(
      harnessRootFor(this.deps.projectRoot),
      ledgerRepositoryFor(this.workflowDeps()).operations(),
      workflowOperationId,
    );
  }

  /**
   * Materialize one authoritative RemoteApprovalDecision into the existing
   * ApprovalDecision chain (design §13.1). The request must carry the
   * first-class requester Principal binding — a legacy request without it is
   * never remotely decidable and must be re-issued under the current
   * connection. Every binding is revalidated exactly like a local decision;
   * the committed record binds the remote decision digest in its extension
   * and keeps the remote `decided_at`. A retry after a lost response finds
   * the already-materialized decision by that digest and replays it.
   */
  async resolveRemoteDecision(
    input: ResolveRemoteDecisionInput,
  ): Promise<RemoteDecisionResolution> {
    const request = this.getRequestById(input.requestId);
    const existing = this.decisions(request.workflow_operation_id).find(
      (decision) => remoteDecisionDigestOf(decision) === input.remoteDecisionDigest,
    );
    if (existing !== undefined) return { decision: existing, replayed: true };
    if (request.requester_principal_id === undefined) {
      throw new ApprovalError(
        "approval_binding_mismatch",
        `approval request ${request.request_id} has no requester principal binding; re-issue it under the current connection before remote approval`,
      );
    }
    this.requirePending(request);
    if (!request.allowed_decisions.includes(input.decision)) {
      throw new ApprovalError(
        "approval_decision_not_allowed",
        `decision ${input.decision} is not allowed for request ${input.requestId}`,
      );
    }
    if (input.objectDigest !== request.object_digest) {
      throw new ApprovalError(
        "approval_binding_mismatch",
        `decision binds object digest ${input.objectDigest} but request ${input.requestId} controls ${request.object_digest}`,
      );
    }
    if (input.actor === proposedByOf(request) || input.actor === request.requester_principal_id) {
      throw new ApprovalError(
        "approval_self_approval",
        `actor ${input.actor} may not resolve its own approval request ${input.requestId}`,
      );
    }
    const current = this.currentBinding(request);
    const drifted = bindingDrift(request, current);
    if (drifted.length > 0) {
      const reissued = await this.invalidateAndReissue(request, current, drifted);
      throw new ApprovalError(
        "approval_binding_drift",
        `approval request ${request.request_id} bindings drifted (${drifted.join(", ")}); re-issued as ${reissued.request_id}`,
        { new_request_id: reissued.request_id, changed: drifted },
      );
    }
    const record = buildApprovalDecision({
      approvalId: newIdOf(this.deps, "approval_decision"),
      requestId: request.request_id,
      actor: input.actor,
      decision: input.decision,
      objectDigest: input.objectDigest,
      decidedAt: input.decidedAt,
      remoteDecisionDigest: input.remoteDecisionDigest,
    });
    const artifact = approvalDecisionArtifact(record);
    await this.engine().commitCheckpoint(request.workflow_operation_id, {
      boundary: "approval",
      ...readerVersionPin(record),
      proposal: {
        add_approval_digests: [sha256Hex(artifact.content)],
        reconcile_blockers:
          record.decision === "defer"
            ? { pending_approval_ids: [request.request_id] }
            : { resolved_approval_ids: [request.request_id] },
      },
      artifacts: [artifact],
      events: [
        remoteApprovalMaterializedEvent({
          requestId: request.request_id,
          approvalId: record.approval_id,
          remoteDecisionId: input.remoteDecisionId,
          remoteDecisionDigest: input.remoteDecisionDigest,
          principalId: input.actor,
        }),
      ],
    });
    return { decision: record, replayed: false };
  }

  private currentBinding(request: ApprovalRequestRecord): ApprovalBindingSnapshot {
    if (this.deps.readBinding !== undefined) return this.deps.readBinding(request);
    return {
      objectDigest: request.object_digest,
      baselineDigest: request.baseline_digest,
      policyDigest: request.policy_digest,
      impactPath: [...request.impact_path],
    };
  }

  private async invalidateAndReissue(
    request: ApprovalRequestRecord,
    current: ApprovalBindingSnapshot,
    drifted: readonly string[],
  ): Promise<ApprovalRequestRecord> {
    const reissued = buildApprovalRequest(
      reissueRequestSpec(request, current, {
        requestId: newIdOf(this.deps, "approval_request"),
        createdAt: nowOf(this.deps),
        proposedBy: proposedByOf(request) ?? "unknown",
      }),
    );
    await this.engine().commitCheckpoint(request.workflow_operation_id, {
      boundary: "approval",
      ...readerVersionPin(reissued),
      proposal: {
        phase: request.resume_phase,
        set_next_action: resumeCommandFor(request.workflow_operation_id),
        add_blockers: [`approval request ${reissued.request_id} awaiting a decision`],
        reconcile_blockers: {
          pending_approval_ids: [reissued.request_id],
          resolved_approval_ids: [request.request_id],
        },
      },
      artifacts: [approvalRequestArtifact(reissued)],
      events: [
        {
          eventType: "ApprovalRequired",
          payload: {
            request_id: reissued.request_id,
            invalidated_request_id: request.request_id,
            changed: [...drifted],
            reason: "approval binding drift",
          },
        },
      ],
    });
    return reissued;
  }
}
