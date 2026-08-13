import { contentDigest } from "@universal-harness-internal/core";

/**
 * Authoritative WorkingState (design 10.2). The Workflow Engine is the only
 * writer: adapters receive a read view and return a typed
 * `WorkingStateProposal`; the engine validates and applies it, then persists
 * the result inside a checkpoint. Commit paths are gated by a
 * `WorkingStateWriter` capability token whose factory is package-internal,
 * so no adapter can mint one through the public API.
 */
export interface ConfirmedFact {
  readonly fact: string;
  readonly evidence_id: string;
}

export interface RejectedHypothesis {
  readonly hypothesis: string;
  readonly evidence_id: string;
}

export interface BudgetUse {
  readonly used_steps: number;
  readonly used_tokens: number;
  readonly ceiling_steps: number;
  readonly ceiling_tokens: number;
}

export const EXTERNAL_ACTION_STATUSES = ["pending", "completed", "uncertain"] as const;

export type ExternalActionStatus = (typeof EXTERNAL_ACTION_STATUSES)[number];

/** External Action Intent recorded before any side effect (design 14). */
export interface ExternalActionIntent {
  readonly intent_id: string;
  readonly tool: string;
  readonly request_digest: string;
  readonly idempotency_key: string;
  readonly status: ExternalActionStatus;
}

/** Content of every committed checkpoint (design 10.2). */
export interface WorkingState {
  readonly goal: string;
  /** Git commit the owning iteration binds to. */
  readonly baseline_commit: string;
  readonly requirement_baseline_digest: string;
  readonly policy_digest: string;
  readonly phase: string;
  readonly task_id?: string;
  readonly previous_checkpoint_id?: string;
  readonly confirmed_facts: readonly ConfirmedFact[];
  readonly rejected_hypotheses: readonly RejectedHypothesis[];
  readonly open_questions: readonly string[];
  readonly blockers: readonly string[];
  readonly next_action?: string;
  readonly completed_task_ids: readonly string[];
  readonly pending_task_ids: readonly string[];
  readonly budget: BudgetUse;
  readonly capability_grants: readonly string[];
  /** SHA-256 of each committed approval decision artifact still relied on. */
  readonly approval_digests: readonly string[];
  readonly context_bundle_digest?: string;
  readonly input_digests: readonly string[];
  readonly external_action_intents: readonly ExternalActionIntent[];
}

/**
 * Typed proposal: the only way an adapter may influence WorkingState. Every
 * field is additive or explicitly scoped; the engine applies it
 * deterministically and owns the commit.
 */
export interface WorkingStateProposal {
  readonly phase?: string;
  readonly task_id?: string;
  readonly add_confirmed_facts?: readonly ConfirmedFact[];
  readonly add_rejected_hypotheses?: readonly RejectedHypothesis[];
  readonly add_open_questions?: readonly string[];
  readonly add_blockers?: readonly string[];
  readonly clear_blockers?: readonly string[];
  readonly set_next_action?: string;
  readonly complete_task_ids?: readonly string[];
  readonly add_pending_task_ids?: readonly string[];
  readonly budget_use?: { readonly used_steps?: number; readonly used_tokens?: number };
  readonly add_capability_grants?: readonly string[];
  readonly add_approval_digests?: readonly string[];
  readonly set_context_bundle_digest?: string;
  readonly add_input_digests?: readonly string[];
  readonly upsert_external_action_intents?: readonly ExternalActionIntent[];
}

export type WorkingStateErrorKind =
  "working_state_writer_required" | "invalid_working_state" | "budget_ceiling";

export class WorkingStateError extends Error {
  readonly kind: WorkingStateErrorKind;

  constructor(kind: WorkingStateErrorKind, message: string) {
    super(message);
    this.name = "WorkingStateError";
    this.kind = kind;
  }
}

/** Capability token; only objects issued by `createWorkingStateWriter` pass. */
export type WorkingStateWriter = Readonly<{ role: "workflow-engine" }>;

const issuedWriters = new WeakSet<WorkingStateWriter>();

/**
 * Mint a writer token. Deliberately NOT re-exported from the package index:
 * the public API offers no way to obtain one, so only the engine module that
 * imports this file directly can commit WorkingState.
 */
export function createWorkingStateWriter(): WorkingStateWriter {
  const writer: WorkingStateWriter = { role: "workflow-engine" };
  issuedWriters.add(writer);
  return writer;
}

export function assertWorkingStateWriter(writer: WorkingStateWriter): void {
  if (!issuedWriters.has(writer)) {
    throw new WorkingStateError(
      "working_state_writer_required",
      "WorkingState commits require the workflow engine writer token; adapters must return a typed WorkingStateProposal instead",
    );
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueFacts(facts: readonly ConfirmedFact[]): ConfirmedFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.fact}${fact.evidence_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueHypotheses(hypotheses: readonly RejectedHypothesis[]): RejectedHypothesis[] {
  const seen = new Set<string>();
  return hypotheses.filter((hypothesis) => {
    const key = `${hypothesis.hypothesis}${hypothesis.evidence_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Apply a typed proposal deterministically; the result is a new object. */
export function applyWorkingStateProposal(
  state: WorkingState,
  proposal: WorkingStateProposal,
): WorkingState {
  const usedSteps = state.budget.used_steps + (proposal.budget_use?.used_steps ?? 0);
  const usedTokens = state.budget.used_tokens + (proposal.budget_use?.used_tokens ?? 0);
  if (usedSteps > state.budget.ceiling_steps || usedTokens > state.budget.ceiling_tokens) {
    throw new WorkingStateError(
      "budget_ceiling",
      `budget ceiling exceeded: steps ${usedSteps}/${state.budget.ceiling_steps}, tokens ${usedTokens}/${state.budget.ceiling_tokens}`,
    );
  }

  const completed = new Set(state.completed_task_ids);
  for (const taskId of proposal.complete_task_ids ?? []) completed.add(taskId);
  const pending = uniqueStrings([
    ...state.pending_task_ids.filter((taskId) => !completed.has(taskId)),
    ...(proposal.add_pending_task_ids ?? []).filter((taskId) => !completed.has(taskId)),
  ]);

  const intents = new Map<string, ExternalActionIntent>();
  for (const intent of state.external_action_intents) intents.set(intent.intent_id, intent);
  for (const intent of proposal.upsert_external_action_intents ?? []) {
    intents.set(intent.intent_id, intent);
  }

  const clearBlockers = new Set(proposal.clear_blockers ?? []);
  return {
    ...state,
    ...(proposal.phase === undefined ? {} : { phase: proposal.phase }),
    ...(proposal.task_id === undefined ? {} : { task_id: proposal.task_id }),
    confirmed_facts: uniqueFacts([
      ...state.confirmed_facts,
      ...(proposal.add_confirmed_facts ?? []),
    ]),
    rejected_hypotheses: uniqueHypotheses([
      ...state.rejected_hypotheses,
      ...(proposal.add_rejected_hypotheses ?? []),
    ]),
    open_questions: uniqueStrings([
      ...state.open_questions,
      ...(proposal.add_open_questions ?? []),
    ]),
    blockers: uniqueStrings([
      ...state.blockers.filter((blocker) => !clearBlockers.has(blocker)),
      ...(proposal.add_blockers ?? []),
    ]),
    ...(proposal.set_next_action === undefined ? {} : { next_action: proposal.set_next_action }),
    completed_task_ids: [...completed],
    pending_task_ids: pending,
    budget: { ...state.budget, used_steps: usedSteps, used_tokens: usedTokens },
    capability_grants: uniqueStrings([
      ...state.capability_grants,
      ...(proposal.add_capability_grants ?? []),
    ]),
    approval_digests: uniqueStrings([
      ...state.approval_digests,
      ...(proposal.add_approval_digests ?? []),
    ]),
    ...(proposal.set_context_bundle_digest === undefined
      ? {}
      : { context_bundle_digest: proposal.set_context_bundle_digest }),
    input_digests: uniqueStrings([...state.input_digests, ...(proposal.add_input_digests ?? [])]),
    external_action_intents: [...intents.values()],
  };
}

/** Content digest of a WorkingState; recorded as `state_digest` in checkpoints. */
export function workingStateDigest(state: WorkingState): string {
  return contentDigest(state);
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isDigestArray(value: unknown): boolean {
  return isStringArray(value) && value.every((entry) => DIGEST_PATTERN.test(entry));
}

function isFactArray(value: unknown): value is ConfirmedFact[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ConfirmedFact).fact === "string" &&
        typeof (entry as ConfirmedFact).evidence_id === "string",
    )
  );
}

function isHypothesisArray(value: unknown): value is RejectedHypothesis[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RejectedHypothesis).hypothesis === "string" &&
        typeof (entry as RejectedHypothesis).evidence_id === "string",
    )
  );
}

function isIntentArray(value: unknown): value is ExternalActionIntent[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ExternalActionIntent).intent_id === "string" &&
        typeof (entry as ExternalActionIntent).tool === "string" &&
        DIGEST_PATTERN.test((entry as ExternalActionIntent).request_digest) &&
        typeof (entry as ExternalActionIntent).idempotency_key === "string" &&
        (EXTERNAL_ACTION_STATUSES as readonly string[]).includes(
          (entry as ExternalActionIntent).status,
        ),
    )
  );
}

function isBudget(value: unknown): value is BudgetUse {
  if (typeof value !== "object" || value === null) return false;
  const budget = value as BudgetUse;
  return (
    Number.isInteger(budget.used_steps) &&
    budget.used_steps >= 0 &&
    Number.isInteger(budget.used_tokens) &&
    budget.used_tokens >= 0 &&
    Number.isInteger(budget.ceiling_steps) &&
    budget.ceiling_steps >= 0 &&
    Number.isInteger(budget.ceiling_tokens) &&
    budget.ceiling_tokens >= 0
  );
}

/** Structural validation for WorkingState read back from the ledger. */
export function isWorkingState(value: unknown): value is WorkingState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as WorkingState;
  return (
    typeof state.goal === "string" &&
    state.goal.length > 0 &&
    typeof state.baseline_commit === "string" &&
    state.baseline_commit.length >= 7 &&
    DIGEST_PATTERN.test(state.requirement_baseline_digest) &&
    DIGEST_PATTERN.test(state.policy_digest) &&
    typeof state.phase === "string" &&
    state.phase.length > 0 &&
    (state.task_id === undefined || typeof state.task_id === "string") &&
    (state.previous_checkpoint_id === undefined ||
      typeof state.previous_checkpoint_id === "string") &&
    isFactArray(state.confirmed_facts) &&
    isHypothesisArray(state.rejected_hypotheses) &&
    isStringArray(state.open_questions) &&
    isStringArray(state.blockers) &&
    (state.next_action === undefined || typeof state.next_action === "string") &&
    isStringArray(state.completed_task_ids) &&
    isStringArray(state.pending_task_ids) &&
    isBudget(state.budget) &&
    isStringArray(state.capability_grants) &&
    isDigestArray(state.approval_digests) &&
    (state.context_bundle_digest === undefined ||
      DIGEST_PATTERN.test(state.context_bundle_digest)) &&
    isDigestArray(state.input_digests) &&
    isIntentArray(state.external_action_intents)
  );
}

export function assertWorkingState(value: unknown): asserts value is WorkingState {
  if (!isWorkingState(value)) {
    throw new WorkingStateError(
      "invalid_working_state",
      "persisted WorkingState failed structural validation",
    );
  }
}
