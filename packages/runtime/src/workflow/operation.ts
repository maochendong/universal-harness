import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LedgerError,
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  harnessRootFor,
  resolveHarnessPath,
  sha256Hex,
  ulid,
  validateSchema,
  type CommitHooks,
  type CommitResult,
  type EdgeRecord,
  type LifecycleEvent,
  type LockTuning,
  type OperationState,
  type RunRecord,
  type WorkflowOperation,
} from "@universal-harness-internal/core";

import {
  buildCheckpointArtifacts,
  latestValidCheckpoint,
  type CheckpointBoundary,
  type CheckpointRecord,
} from "./checkpoint.js";
import {
  InvalidStateTransition,
  abortTargetFor,
  assertOperationTransition,
  blockTargetFor,
  isResumableOperationState,
  isTerminalOperationState,
  type AbortReason,
  type RecoverableBlockReason,
  type ResumableOperationState,
} from "./state-machine.js";
import {
  applyWorkingStateProposal,
  createWorkingStateWriter,
  type WorkingState,
  type WorkingStateProposal,
  type WorkingStateWriter,
} from "./working-state.js";

/**
 * Workflow Engine (design section 10): the only writer of authoritative
 * WorkingState and the only component that transitions Operation State.
 * Every mutation is one atomic ledger commit carrying the operation record
 * plus any checkpoint/run records and lifecycle events, so an interrupted
 * write never exposes a partial state change.
 */
export type WorkflowIdKind =
  "workflow" | "attempt" | "checkpoint" | "run" | "event" | "ledger" | "edge";

export interface WorkflowDependencies {
  readonly projectRoot: string;
  /** Current Git baseline (HEAD) the next ledger commit must build on. */
  readonly readBaseline: () => string;
  /** Injectable clock (ISO 8601 UTC) for deterministic tests. */
  readonly now?: () => string;
  /** Injectable id mint for deterministic tests; defaults to ULID-based ids. */
  readonly newId?: (kind: WorkflowIdKind) => string;
  /** Commit hooks for durable-boundary fault injection. */
  readonly hooks?: CommitHooks;
  readonly lock?: LockTuning;
}

export type WorkflowErrorKind =
  | "operation_not_found"
  | "operation_corrupt"
  | "operation_not_blocked"
  | "operation_terminal"
  | "working_state_missing"
  | "checkpoint_not_found"
  | "run_not_found"
  | "run_already_terminated"
  | "baseline_mismatch"
  | "approval_invalid"
  | "context_bundle_invalid"
  | "ledger_failure";

export class WorkflowError extends Error {
  readonly kind: WorkflowErrorKind;

  constructor(kind: WorkflowErrorKind, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.kind = kind;
  }
}

export interface StartOperationInput {
  readonly projectId: string;
  readonly iterationId: string;
  readonly goal: string;
  /** Git commit the owning iteration binds to. */
  readonly baselineCommit: string;
  readonly requirementBaselineDigest: string;
  readonly policyDigest: string;
  readonly phase: string;
  readonly pendingTaskIds?: readonly string[];
  readonly inputDigests?: readonly string[];
  readonly capabilityGrants?: readonly string[];
  readonly budgetCeiling: { readonly steps: number; readonly tokens: number };
}

export interface OperationSnapshot {
  readonly operation: WorkflowOperation;
  readonly checkpointId: string;
  readonly ledgerOperationId: string;
}

export interface BlockOperationInput {
  readonly reason: RecoverableBlockReason;
  /** Human-readable blocker recorded in the WorkingState and event payload. */
  readonly detail: string;
  readonly proposal?: WorkingStateProposal;
}

export interface AbortOperationInput {
  readonly reason: AbortReason;
  readonly detail: string;
}

export interface CommitCheckpointInput {
  readonly boundary: CheckpointBoundary;
  readonly proposal: WorkingStateProposal;
  /**
   * Extra ledger artifacts committed atomically with the checkpoint (for
   * example an ApprovalRequest persisted before any human input is awaited).
   */
  readonly artifacts?: readonly { readonly path: string; readonly content: string }[];
  /** Extra lifecycle events appended after the CheckpointCommitted event. */
  readonly events?: readonly {
    readonly eventType: LifecycleEvent["event_type"];
    readonly payload: Record<string, unknown>;
  }[];
}

export interface BlockOutcome {
  readonly operation: WorkflowOperation;
  readonly checkpointId: string;
}

const WORKFLOW_EXTENSION_KEY = "harness.workflow";

function nowOf(deps: WorkflowDependencies): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function newIdOf(deps: WorkflowDependencies, kind: WorkflowIdKind): string {
  return (deps.newId ?? ((idKind) => `${idKind}_${ulid()}`))(kind);
}

export function ledgerRepositoryFor(deps: WorkflowDependencies): LedgerRepository {
  return new LedgerRepository({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    now: () => nowOf(deps),
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    ...(deps.lock === undefined ? {} : { lock: deps.lock }),
  });
}

export function operationRecordArtifactPath(
  workflowOperationId: string,
  sequence: number,
  state: OperationState,
): string {
  return `artifacts/workflow-operations/${workflowOperationId}/${String(sequence).padStart(4, "0")}-${state}.json`;
}

export function runRecordArtifactPath(runId: string, sequence: number, recordKind: string): string {
  return `artifacts/runs/${runId}/${String(sequence).padStart(4, "0")}-${recordKind}.json`;
}

function projectIdOf(record: WorkflowOperation): string {
  const extension = record.extensions?.[WORKFLOW_EXTENSION_KEY];
  if (typeof extension === "object" && extension !== null) {
    const projectId = (extension as { project_id?: unknown }).project_id;
    if (typeof projectId === "string") return projectId;
  }
  throw new WorkflowError(
    "operation_corrupt",
    `workflow operation ${record.workflow_operation_id} is missing its project binding`,
  );
}

function buildOperationRecord(spec: {
  readonly workflowOperationId: string;
  readonly attemptId: string;
  readonly iterationId: string;
  readonly projectId: string;
  readonly state: OperationState;
  readonly resumeState?: ResumableOperationState;
  readonly updatedAt: string;
  readonly detail?: string;
}): WorkflowOperation {
  const extension: Record<string, unknown> = { project_id: spec.projectId };
  if (spec.detail !== undefined) extension.detail = spec.detail;
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "workflow_operation",
    workflow_operation_id: spec.workflowOperationId,
    attempt_id: spec.attemptId,
    iteration_id: spec.iterationId,
    state: spec.state,
    ...(spec.state === "blocked" && spec.resumeState !== undefined
      ? { resume_state: spec.resumeState }
      : {}),
    updated_at: spec.updatedAt,
    extensions: { [WORKFLOW_EXTENSION_KEY]: extension },
  };
  const validation = validateSchema("workflow-operation", record);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new WorkflowError("operation_corrupt", `invalid workflow operation record: ${detail}`);
  }
  return record as unknown as WorkflowOperation;
}

function buildEvent(spec: {
  readonly eventId: string;
  readonly eventType: LifecycleEvent["event_type"];
  readonly projectId: string;
  readonly iterationId: string;
  readonly workflowOperationId: string;
  readonly ledgerOperationId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}): LifecycleEvent {
  const event = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "event",
    event_id: spec.eventId,
    event_type: spec.eventType,
    project_id: spec.projectId,
    iteration_id: spec.iterationId,
    workflow_operation_id: spec.workflowOperationId,
    ledger_operation_id: spec.ledgerOperationId,
    sequence: spec.sequence,
    timestamp: spec.timestamp,
    payload: spec.payload,
  };
  const validation = validateSchema("event", event);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new WorkflowError("operation_corrupt", `invalid lifecycle event: ${detail}`);
  }
  return event as LifecycleEvent;
}

function buildRunRecord(fields: Record<string, unknown>): RunRecord {
  const record = { protocol_version: PROTOCOL_VERSION, ...fields };
  const validation = validateSchema("runtime", record);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new WorkflowError("operation_corrupt", `invalid run record: ${detail}`);
  }
  return record as unknown as RunRecord;
}

export function buildRunStartedRecord(spec: {
  readonly runId: string;
  readonly taskId: string;
  readonly workflowOperationId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly contextBundleId: string;
  readonly contextBundleDigest?: string;
  readonly grantRecordDigest?: string;
  readonly authorizationDigest?: string;
  readonly adapterProfileDigest?: string;
}): RunRecord {
  return buildRunRecord({
    record_kind: "run_started",
    run_id: spec.runId,
    task_id: spec.taskId,
    workflow_operation_id: spec.workflowOperationId,
    attempt_id: spec.attemptId,
    sequence: spec.sequence,
    timestamp: spec.timestamp,
    context_bundle_id: spec.contextBundleId,
    ...(spec.contextBundleDigest === undefined ||
    spec.grantRecordDigest === undefined ||
    spec.authorizationDigest === undefined
      ? {}
      : {
          extensions: {
            "harness.execution": {
              context_bundle_digest: spec.contextBundleDigest,
              grant_record_digest: spec.grantRecordDigest,
              authorization_digest: spec.authorizationDigest,
              ...(spec.adapterProfileDigest === undefined
                ? {}
                : { adapter_profile_digest: spec.adapterProfileDigest }),
            },
          },
        }),
  });
}

export function buildRunInterruptedRecord(spec: {
  readonly runId: string;
  readonly taskId: string;
  readonly workflowOperationId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly outcome: "partial" | "failed" | "handoff";
  readonly partialEvidenceIds: readonly string[];
}): RunRecord {
  return buildRunRecord({
    record_kind: "run_interrupted",
    run_id: spec.runId,
    task_id: spec.taskId,
    workflow_operation_id: spec.workflowOperationId,
    attempt_id: spec.attemptId,
    sequence: spec.sequence,
    timestamp: spec.timestamp,
    outcome: spec.outcome,
    termination_reason: "process_interruption",
    partial_evidence_ids: [...spec.partialEvidenceIds],
  });
}

/** Next lifecycle event sequence for a workflow operation (1-based, append-only). */
export function nextEventSequence(deps: WorkflowDependencies, workflowOperationId: string): number {
  return (
    ledgerRepositoryFor(deps)
      .replay()
      .events.filter((event) => event.workflow_operation_id === workflowOperationId)
      .reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1
  );
}

/**
 * Committed operation records of one workflow operation, oldest first.
 * Artifact bytes no committed manifest references (orphans of an
 * interrupted commit) are skipped, never treated as authoritative — the
 * same rule the ledger replay applies to orphan shards.
 */
export function readOperationHistory(
  deps: WorkflowDependencies,
  workflowOperationId: string,
): WorkflowOperation[] {
  const repository = ledgerRepositoryFor(deps);
  const operations = repository.operations();
  const allowed = new Set<string>();
  for (const operation of operations) {
    if (operation.manifest.workflow_operation_id !== workflowOperationId) continue;
    for (const digest of operation.manifest.artifact_digests) allowed.add(digest);
  }
  const harnessRoot = repository.harnessRoot;
  const directory = resolveHarnessPath(
    harnessRoot,
    `artifacts/workflow-operations/${workflowOperationId}`,
  );
  if (!existsSync(directory)) return [];
  const records: WorkflowOperation[] = [];
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const relative = `artifacts/workflow-operations/${workflowOperationId}/${name}`;
    const bytes = readFileSync(resolveHarnessPath(harnessRoot, relative), "utf8");
    if (!allowed.has(sha256Hex(bytes))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes) as unknown;
    } catch {
      throw new WorkflowError("operation_corrupt", `unparsable operation record: ${relative}`);
    }
    const validation = validateSchema("workflow-operation", parsed);
    if (!validation.valid) {
      throw new WorkflowError("operation_corrupt", `invalid operation record: ${relative}`);
    }
    records.push(parsed as WorkflowOperation);
  }
  return records;
}

export function readCurrentOperation(
  deps: WorkflowDependencies,
  workflowOperationId: string,
): WorkflowOperation | undefined {
  return readOperationHistory(deps, workflowOperationId).at(-1);
}

export interface RunStream {
  readonly runId: string;
  readonly records: readonly RunRecord[];
}

export function streamTerminalRecord(stream: RunStream): RunRecord | undefined {
  const last = stream.records.at(-1);
  if (last === undefined) return undefined;
  return last.record_kind === "run_terminated" || last.record_kind === "run_interrupted"
    ? last
    : undefined;
}

/** All run record streams of a workflow operation, grouped by run, sequence ordered. */
export function readRunStreams(
  deps: WorkflowDependencies,
  workflowOperationId: string,
): RunStream[] {
  const repository = ledgerRepositoryFor(deps);
  const operations = repository.operations();
  const allowed = new Set<string>();
  for (const operation of operations) {
    if (operation.manifest.workflow_operation_id !== workflowOperationId) continue;
    for (const digest of operation.manifest.artifact_digests) allowed.add(digest);
  }
  const harnessRoot = repository.harnessRoot;
  const runsRoot = resolveHarnessPath(harnessRoot, "artifacts/runs");
  if (!existsSync(runsRoot)) return [];
  const streams: RunStream[] = [];
  for (const runId of readdirSync(runsRoot).sort()) {
    const runDirectory = join(runsRoot, runId);
    const records: RunRecord[] = [];
    for (const name of readdirSync(runDirectory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()) {
      const relative = `artifacts/runs/${runId}/${name}`;
      const bytes = readFileSync(resolveHarnessPath(harnessRoot, relative), "utf8");
      // Orphan bytes of an interrupted commit are not authoritative.
      if (!allowed.has(sha256Hex(bytes))) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes) as unknown;
      } catch {
        throw new WorkflowError("operation_corrupt", `unparsable run record: ${relative}`);
      }
      const validation = validateSchema("runtime", parsed);
      if (!validation.valid) {
        throw new WorkflowError("operation_corrupt", `invalid run record: ${relative}`);
      }
      const record = parsed as RunRecord;
      if (record.run_id !== runId || record.workflow_operation_id !== workflowOperationId) continue;
      records.push(record);
    }
    if (records.length > 0) streams.push({ runId, records });
  }
  return streams;
}

async function commitWorkflowTransaction(
  deps: WorkflowDependencies,
  input: {
    readonly ledgerOperationId: string;
    readonly workflowOperationId: string;
    readonly attemptId: string;
    readonly artifacts: readonly { readonly path: string; readonly content: string }[];
    readonly events: readonly LifecycleEvent[];
    readonly edges?: readonly EdgeRecord[];
  },
): Promise<CommitResult> {
  try {
    return await ledgerRepositoryFor(deps).commit({
      ledger_operation_id: input.ledgerOperationId,
      workflow_operation_id: input.workflowOperationId,
      attempt_id: input.attemptId,
      expected_baseline: deps.readBaseline(),
      artifacts: input.artifacts,
      events: input.events,
      ...(input.edges === undefined ? {} : { edges: input.edges }),
    });
  } catch (error) {
    if (error instanceof LedgerError) {
      throw new WorkflowError("ledger_failure", error.message);
    }
    throw error;
  }
}

export class WorkflowEngine {
  private readonly deps: WorkflowDependencies;
  private readonly writer: WorkingStateWriter;

  constructor(deps: WorkflowDependencies) {
    this.deps = deps;
    this.writer = createWorkingStateWriter();
  }

  private now(): string {
    return nowOf(this.deps);
  }

  private newId(kind: WorkflowIdKind): string {
    return newIdOf(this.deps, kind);
  }

  private harnessRoot(): string {
    return harnessRootFor(this.deps.projectRoot);
  }

  /** Current record of an operation, or `undefined` when it does not exist. */
  getOperation(workflowOperationId: string): WorkflowOperation | undefined {
    return readCurrentOperation(this.deps, workflowOperationId);
  }

  /** WorkingState of the latest valid checkpoint, if any. */
  getWorkingState(workflowOperationId: string): WorkingState | undefined {
    const repository = ledgerRepositoryFor(this.deps);
    return latestValidCheckpoint(this.harnessRoot(), repository.operations(), workflowOperationId)
      ?.workingState;
  }

  private requireOperation(workflowOperationId: string): WorkflowOperation {
    const current = this.getOperation(workflowOperationId);
    if (current === undefined) {
      throw new WorkflowError(
        "operation_not_found",
        `unknown workflow operation: ${workflowOperationId}`,
      );
    }
    return current;
  }

  private requireWorkingState(workflowOperationId: string): {
    readonly checkpointId: string;
    readonly workingState: WorkingState;
  } {
    const repository = ledgerRepositoryFor(this.deps);
    const committed = latestValidCheckpoint(
      this.harnessRoot(),
      repository.operations(),
      workflowOperationId,
    );
    if (committed === undefined) {
      throw new WorkflowError(
        "working_state_missing",
        `workflow operation ${workflowOperationId} has no valid checkpoint to build on`,
      );
    }
    return { checkpointId: committed.record.checkpoint_id, workingState: committed.workingState };
  }

  private operationArtifact(
    record: WorkflowOperation,
    sequence: number,
  ): { readonly path: string; readonly content: string } {
    return {
      path: operationRecordArtifactPath(record.workflow_operation_id, sequence, record.state),
      content: `${canonicalizeJson(record)}\n`,
    };
  }

  /**
   * Open a workflow operation: commits the initial operation record, the
   * initial WorkingState checkpoint and the OperationStarted event in one
   * atomic ledger commit.
   */
  async startOperation(input: StartOperationInput): Promise<OperationSnapshot> {
    const workflowOperationId = this.newId("workflow");
    const attemptId = this.newId("attempt");
    const checkpointId = this.newId("checkpoint");
    const ledgerOperationId = this.newId("ledger");
    const timestamp = this.now();

    const workingState: WorkingState = {
      goal: input.goal,
      baseline_commit: input.baselineCommit,
      requirement_baseline_digest: input.requirementBaselineDigest,
      policy_digest: input.policyDigest,
      phase: input.phase,
      confirmed_facts: [],
      rejected_hypotheses: [],
      open_questions: [],
      blockers: [],
      completed_task_ids: [],
      pending_task_ids: [...new Set(input.pendingTaskIds ?? [])],
      budget: {
        used_steps: 0,
        used_tokens: 0,
        ceiling_steps: input.budgetCeiling.steps,
        ceiling_tokens: input.budgetCeiling.tokens,
      },
      capability_grants: [...new Set(input.capabilityGrants ?? [])],
      approval_digests: [],
      input_digests: [...new Set(input.inputDigests ?? [])],
      external_action_intents: [],
    };
    const operation = buildOperationRecord({
      workflowOperationId,
      attemptId,
      iterationId: input.iterationId,
      projectId: input.projectId,
      state: "created",
      updatedAt: timestamp,
    });
    const checkpoint = buildCheckpointArtifacts(this.writer, {
      checkpoint_id: checkpointId,
      workflow_operation_id: workflowOperationId,
      attempt_id: attemptId,
      phase: input.phase,
      timestamp,
      working_state: workingState,
    });
    const events = [
      buildEvent({
        eventId: this.newId("event"),
        eventType: "OperationStarted",
        projectId: input.projectId,
        iterationId: input.iterationId,
        workflowOperationId,
        ledgerOperationId,
        sequence: 1,
        timestamp,
        payload: { goal: input.goal, phase: input.phase },
      }),
      buildEvent({
        eventId: this.newId("event"),
        eventType: "CheckpointCommitted",
        projectId: input.projectId,
        iterationId: input.iterationId,
        workflowOperationId,
        ledgerOperationId,
        sequence: 2,
        timestamp,
        payload: { boundary: "snapshot", trigger: "operation_start", checkpoint_id: checkpointId },
      }),
    ];
    await commitWorkflowTransaction(this.deps, {
      ledgerOperationId,
      workflowOperationId,
      attemptId,
      artifacts: [this.operationArtifact(operation, 1), ...checkpoint.files],
      events,
    });
    return { operation, checkpointId, ledgerOperationId };
  }

  /** Advance along the delivery chain; blocking and aborting have dedicated paths. */
  async advance(workflowOperationId: string, to: OperationState): Promise<WorkflowOperation> {
    const current = this.requireOperation(workflowOperationId);
    if (to === "blocked" || to === "aborted") {
      throw new InvalidStateTransition(
        `use block() or abort() to reach ${to}; the transition must record its typed reason`,
      );
    }
    assertOperationTransition(current.state, to);
    const timestamp = this.now();
    const history = readOperationHistory(this.deps, workflowOperationId);
    const operation = buildOperationRecord({
      workflowOperationId,
      attemptId: current.attempt_id,
      iterationId: current.iteration_id,
      projectId: projectIdOf(current),
      state: to,
      updatedAt: timestamp,
    });
    const ledgerOperationId = this.newId("ledger");
    const events: LifecycleEvent[] = [];
    if (to === "completed") {
      events.push(
        buildEvent({
          eventId: this.newId("event"),
          eventType: "OperationCompleted",
          projectId: projectIdOf(current),
          iterationId: current.iteration_id,
          workflowOperationId,
          ledgerOperationId,
          sequence: nextEventSequence(this.deps, workflowOperationId),
          timestamp,
          payload: { outcome: "completed" },
        }),
      );
    }
    await commitWorkflowTransaction(this.deps, {
      ledgerOperationId,
      workflowOperationId,
      attemptId: current.attempt_id,
      artifacts: [this.operationArtifact(operation, history.length + 1)],
      events,
    });
    return operation;
  }

  /**
   * Recoverable failure -> `blocked`: one atomic commit persisting the
   * blocked operation record (with `resume_state`), the blocked-snapshot
   * checkpoint and the CheckpointCommitted event.
   */
  async block(workflowOperationId: string, input: BlockOperationInput): Promise<BlockOutcome> {
    const current = this.requireOperation(workflowOperationId);
    const target = blockTargetFor(current.state, input.reason);
    const base = this.requireWorkingState(workflowOperationId);
    const timestamp = this.now();
    const proposal: WorkingStateProposal = {
      ...input.proposal,
      add_blockers: [...(input.proposal?.add_blockers ?? []), input.detail],
    };
    const workingState: WorkingState = {
      ...applyWorkingStateProposal(base.workingState, proposal),
      previous_checkpoint_id: base.checkpointId,
    };
    const history = readOperationHistory(this.deps, workflowOperationId);
    const operation = buildOperationRecord({
      workflowOperationId,
      attemptId: current.attempt_id,
      iterationId: current.iteration_id,
      projectId: projectIdOf(current),
      state: target.state,
      resumeState: target.resume_state,
      updatedAt: timestamp,
      detail: input.detail,
    });
    const checkpointId = this.newId("checkpoint");
    const ledgerOperationId = this.newId("ledger");
    const checkpoint = buildCheckpointArtifacts(this.writer, {
      checkpoint_id: checkpointId,
      workflow_operation_id: workflowOperationId,
      attempt_id: current.attempt_id,
      phase: workingState.phase,
      timestamp,
      working_state: workingState,
    });
    const events = [
      buildEvent({
        eventId: this.newId("event"),
        eventType: "CheckpointCommitted",
        projectId: projectIdOf(current),
        iterationId: current.iteration_id,
        workflowOperationId,
        ledgerOperationId,
        sequence: nextEventSequence(this.deps, workflowOperationId),
        timestamp,
        payload: {
          boundary: "snapshot",
          trigger: "blocked",
          reason: input.reason,
          resume_state: target.resume_state,
          checkpoint_id: checkpointId,
        },
      }),
    ];
    await commitWorkflowTransaction(this.deps, {
      ledgerOperationId,
      workflowOperationId,
      attemptId: current.attempt_id,
      artifacts: [this.operationArtifact(operation, history.length + 1), ...checkpoint.files],
      events,
    });
    return { operation, checkpointId };
  }

  /** Explicit cancellation or typed unrecoverable reason -> terminal `aborted`. */
  async abort(workflowOperationId: string, input: AbortOperationInput): Promise<WorkflowOperation> {
    const current = this.requireOperation(workflowOperationId);
    abortTargetFor(current.state, input.reason);
    const timestamp = this.now();
    const history = readOperationHistory(this.deps, workflowOperationId);
    const operation = buildOperationRecord({
      workflowOperationId,
      attemptId: current.attempt_id,
      iterationId: current.iteration_id,
      projectId: projectIdOf(current),
      state: "aborted",
      updatedAt: timestamp,
      detail: input.detail,
    });
    const ledgerOperationId = this.newId("ledger");
    const events = [
      buildEvent({
        eventId: this.newId("event"),
        eventType: "OperationCompleted",
        projectId: projectIdOf(current),
        iterationId: current.iteration_id,
        workflowOperationId,
        ledgerOperationId,
        sequence: nextEventSequence(this.deps, workflowOperationId),
        timestamp,
        payload: { outcome: "aborted", reason: input.reason, detail: input.detail },
      }),
    ];
    await commitWorkflowTransaction(this.deps, {
      ledgerOperationId,
      workflowOperationId,
      attemptId: current.attempt_id,
      artifacts: [this.operationArtifact(operation, history.length + 1)],
      events,
    });
    return operation;
  }

  /**
   * Persist a checkpoint at a durable boundary (authoritative commit,
   * approval, task, gate, external action, snapshot). The WorkingState
   * change arrives as a typed proposal; the engine applies and commits it.
   */
  async commitCheckpoint(
    workflowOperationId: string,
    input: CommitCheckpointInput,
  ): Promise<CheckpointRecord> {
    const current = this.requireOperation(workflowOperationId);
    if (!isResumableOperationState(current.state)) {
      if (isTerminalOperationState(current.state)) {
        throw new WorkflowError(
          "operation_terminal",
          `cannot checkpoint terminal operation in state ${current.state}`,
        );
      }
      throw new InvalidStateTransition(
        `cannot checkpoint operation in state ${current.state}; resume it first`,
      );
    }
    const base = this.requireWorkingState(workflowOperationId);
    const timestamp = this.now();
    const workingState: WorkingState = {
      ...applyWorkingStateProposal(base.workingState, input.proposal),
      previous_checkpoint_id: base.checkpointId,
    };
    const checkpointId = this.newId("checkpoint");
    const ledgerOperationId = this.newId("ledger");
    const checkpoint = buildCheckpointArtifacts(this.writer, {
      checkpoint_id: checkpointId,
      workflow_operation_id: workflowOperationId,
      attempt_id: current.attempt_id,
      phase: workingState.phase,
      timestamp,
      working_state: workingState,
    });
    const firstSequence = nextEventSequence(this.deps, workflowOperationId);
    const events = [
      buildEvent({
        eventId: this.newId("event"),
        eventType: "CheckpointCommitted",
        projectId: projectIdOf(current),
        iterationId: current.iteration_id,
        workflowOperationId,
        ledgerOperationId,
        sequence: firstSequence,
        timestamp,
        payload: {
          boundary: input.boundary,
          phase: workingState.phase,
          checkpoint_id: checkpointId,
        },
      }),
      ...(input.events ?? []).map((extra, offset) =>
        buildEvent({
          eventId: this.newId("event"),
          eventType: extra.eventType,
          projectId: projectIdOf(current),
          iterationId: current.iteration_id,
          workflowOperationId,
          ledgerOperationId,
          sequence: firstSequence + 1 + offset,
          timestamp,
          payload: extra.payload,
        }),
      ),
    ];
    await commitWorkflowTransaction(this.deps, {
      ledgerOperationId,
      workflowOperationId,
      attemptId: current.attempt_id,
      artifacts: [...(input.artifacts ?? []), ...checkpoint.files],
      events,
    });
    return checkpoint.record;
  }

  /** Open a run for a task; only legal while the operation is executing. */
  async startRun(
    workflowOperationId: string,
    input: {
      readonly taskId: string;
      readonly contextBundleId: string;
      readonly contextBundleDigest?: string;
      readonly grantRecordDigest?: string;
      readonly authorizationDigest?: string;
      readonly adapterProfileDigest?: string;
    },
  ): Promise<RunRecord> {
    const current = this.requireOperation(workflowOperationId);
    if (current.state !== "running" && current.state !== "repairing") {
      throw new InvalidStateTransition(
        `runs may only start while the operation is running, not ${current.state}`,
      );
    }
    const runId = this.newId("run");
    const ledgerOperationId = this.newId("ledger");
    const record = buildRunStartedRecord({
      runId,
      taskId: input.taskId,
      workflowOperationId,
      attemptId: current.attempt_id,
      sequence: 1,
      timestamp: this.now(),
      contextBundleId: input.contextBundleId,
      ...(input.contextBundleDigest === undefined
        ? {}
        : { contextBundleDigest: input.contextBundleDigest }),
      ...(input.grantRecordDigest === undefined
        ? {}
        : { grantRecordDigest: input.grantRecordDigest }),
      ...(input.authorizationDigest === undefined
        ? {}
        : { authorizationDigest: input.authorizationDigest }),
      ...(input.adapterProfileDigest === undefined
        ? {}
        : { adapterProfileDigest: input.adapterProfileDigest }),
    });
    await commitWorkflowTransaction(this.deps, {
      ledgerOperationId,
      workflowOperationId,
      attemptId: current.attempt_id,
      artifacts: [
        {
          path: runRecordArtifactPath(runId, 1, "run_started"),
          content: `${canonicalizeJson(record)}\n`,
        },
      ],
      events: [],
    });
    return record;
  }

  /** Append the terminal record of a run; a terminated run is never reopened. */
  async terminateRun(
    workflowOperationId: string,
    input: {
      readonly runId: string;
      readonly outcome:
        "success" | "correct_block" | "clarification_required" | "handoff" | "partial" | "failed";
      readonly terminationReason:
        | "completion"
        | "gate_failure"
        | "policy_denial"
        | "budget_ceiling"
        | "repeat_detection"
        | "timeout"
        | "adapter_failure"
        | "user_cancellation"
        | "manual_stop";
    },
  ): Promise<RunRecord> {
    this.requireOperation(workflowOperationId);
    const stream = readRunStreams(this.deps, workflowOperationId).find(
      (candidate) => candidate.runId === input.runId,
    );
    if (stream === undefined) {
      throw new WorkflowError("run_not_found", `unknown run: ${input.runId}`);
    }
    if (streamTerminalRecord(stream) !== undefined) {
      throw new WorkflowError(
        "run_already_terminated",
        `run ${input.runId} already has a terminal record`,
      );
    }
    const started = stream.records[0];
    if (started === undefined || started.record_kind !== "run_started") {
      throw new WorkflowError("operation_corrupt", `run ${input.runId} has no RunStarted record`);
    }
    const sequence = stream.records.reduce((max, record) => Math.max(max, record.sequence), 0) + 1;
    const record = buildRunRecord({
      record_kind: "run_terminated",
      run_id: input.runId,
      task_id: started.task_id,
      workflow_operation_id: workflowOperationId,
      attempt_id: started.attempt_id,
      sequence,
      timestamp: this.now(),
      outcome: input.outcome,
      termination_reason: input.terminationReason,
    });
    const ledgerOperationId = this.newId("ledger");
    await commitWorkflowTransaction(this.deps, {
      ledgerOperationId,
      workflowOperationId,
      attemptId: started.attempt_id,
      artifacts: [
        {
          path: runRecordArtifactPath(input.runId, sequence, "run_terminated"),
          content: `${canonicalizeJson(record)}\n`,
        },
      ],
      events: [],
    });
    return record;
  }
}
