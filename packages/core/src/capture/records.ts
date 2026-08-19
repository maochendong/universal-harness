import { canonicalStringSet } from "../identity/canonical-set.js";
import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import type {
  CaptureBlockReason,
  CaptureBlockerRecord,
  CaptureBudgetUse,
  CaptureCheckpointRecord,
  CaptureInvocationPurpose,
  CaptureInvocationRecord,
  CaptureSessionRecord,
  CaptureState,
  ClarificationAnswerRecord,
  ClarificationOption,
  ClarificationQuestionRecord,
} from "../schema/capture.js";
import {
  CAPTURE_ANSWER_KINDS,
  CAPTURE_INVOCATION_PURPOSES,
  CAPTURE_QUESTION_SOURCES,
  CAPTURE_QUESTION_TARGET_KINDS,
} from "../schema/capture.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import {
  CaptureStateInvariantError,
  CaptureTransitionError,
  assertCaptureStateFields,
  assertCaptureTransition,
  isCaptureState,
  isTerminalCaptureState,
} from "./states.js";

/**
 * Constructors for the Protocol 1.1 capture records (intent-to-prd design
 * 6/7). Identity is derived deterministically with `domainRecordId`, all
 * collections are canonically ordered before sealing, and the conditional
 * blocked-reason invariant is enforced here so no caller can construct a
 * session the store would later reject.
 */
export class CaptureRecordError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "CaptureRecordError";
    this.kind = kind;
  }
}

/** A normalized clarification request produced by a stage handler; the
 * Coordinator owns dedup, ordering and identity minting. */
export interface ClarificationQuestionDraft {
  readonly source: ClarificationQuestionRecord["source"];
  readonly target_kind: ClarificationQuestionRecord["target_kind"];
  readonly target_id?: string;
  readonly missing_dimension: string;
  readonly question: string;
  readonly options?: readonly ClarificationOption[];
  readonly required: boolean;
}

const DIGEST_REGEX = /^[a-f0-9]{64}$/u;

function assertDigest(kind: string, value: string, field: string): void {
  if (!DIGEST_REGEX.test(value)) {
    throw new CaptureRecordError(kind, `${field} must be a lowercase sha-256 hex digest`);
  }
}

function assertSessionDigests(input: {
  readonly project_profile_digest: string;
  readonly profile_decision_digest: string;
  readonly capture_policy_digest: string;
  readonly project_baseline_digest: string;
}): void {
  assertDigest("invalid_digest", input.project_profile_digest, "project_profile_digest");
  assertDigest("invalid_digest", input.profile_decision_digest, "profile_decision_digest");
  assertDigest("invalid_digest", input.capture_policy_digest, "capture_policy_digest");
  assertDigest("invalid_digest", input.project_baseline_digest, "project_baseline_digest");
}

export function intentDigestOf(intentText: string): string {
  return contentDigest(intentText.normalize("NFC").trim());
}

export interface CreateCaptureSessionInput {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly intent_text: string;
  readonly project_profile_digest: string;
  readonly profile_decision_digest: string;
  readonly capture_policy_digest: string;
  readonly project_baseline_digest: string;
}

/**
 * Revision 1 at `intent_received`. The session identity derives from the
 * workflow operation and the intent digest, so re-issuing the same start
 * command resolves to the same session instead of forking a duplicate.
 */
export function createCaptureSessionRecord(input: CreateCaptureSessionInput): CaptureSessionRecord {
  assertSessionDigests(input);
  if (input.intent_text.trim().length === 0) {
    throw new CaptureRecordError("empty_intent", "intent_text must not be empty");
  }
  const intentDigest = intentDigestOf(input.intent_text);
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "capture_session" as const,
    session_id: domainRecordId({
      domain_tag: "capture_session",
      id_prefix: "capture-session",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        workflow_operation_id: input.workflow_operation_id,
        intent_digest: intentDigest,
      },
    }),
    revision: 1,
    workflow_operation_id: input.workflow_operation_id,
    iteration_id: input.iteration_id,
    state: "intent_received" as const,
    intent_text: input.intent_text,
    intent_digest: intentDigest,
    project_profile_digest: input.project_profile_digest,
    profile_decision_digest: input.profile_decision_digest,
    capture_policy_digest: input.capture_policy_digest,
    project_baseline_digest: input.project_baseline_digest,
    pending_question_ids: [],
    round: 0,
    budget_use: { clarification_rounds: 0, proposal_invocations: 0, review_invocations: 0 },
  });
}

/** Fields a new revision may change; everything else is inherited. */
export interface CaptureSessionRevisionPatch {
  readonly state: CaptureState;
  readonly blocked_reason?: CaptureBlockReason;
  readonly intent_text?: string;
  readonly proposal_context_bundle_digest?: string;
  readonly review_context_bundle_digest?: string;
  readonly current_proposal_digest?: string;
  readonly current_validation_digest?: string;
  readonly current_review_digest?: string;
  readonly current_risk_assessment_digest?: string;
  readonly current_approval_request_id?: string;
  readonly applied_approval_decision_id?: string;
  readonly pending_question_ids?: readonly string[];
  readonly round?: number;
}

/**
 * Append the next revision. Enforces the transition table, the blocked-reason
 * invariant and canonical ordering of the pending question set. Leaving
 * `blocked` always drops the reason; entering it always requires one.
 */
export function reviseCaptureSessionRecord(
  previous: CaptureSessionRecord,
  patch: CaptureSessionRevisionPatch,
  budgetUse: CaptureBudgetUse,
): CaptureSessionRecord {
  try {
    assertCaptureTransition(previous.state, patch.state);
    assertCaptureStateFields(patch.state, patch.blocked_reason);
  } catch (error) {
    if (error instanceof CaptureTransitionError || error instanceof CaptureStateInvariantError) {
      throw new CaptureRecordError(error.kind, error.message);
    }
    throw error;
  }
  const intentText = patch.intent_text ?? previous.intent_text;
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "capture_session",
    session_id: previous.session_id,
    revision: previous.revision + 1,
    workflow_operation_id: previous.workflow_operation_id,
    iteration_id: previous.iteration_id,
    state: patch.state,
    intent_text: intentText,
    intent_digest: intentDigestOf(intentText),
    project_profile_digest: previous.project_profile_digest,
    profile_decision_digest: previous.profile_decision_digest,
    capture_policy_digest: previous.capture_policy_digest,
    project_baseline_digest: previous.project_baseline_digest,
    pending_question_ids: canonicalStringSet([
      ...(patch.pending_question_ids ?? previous.pending_question_ids),
    ]),
    round: patch.round ?? previous.round,
    budget_use: budgetUse,
    supersedes_digest: previous.record_digest,
  };
  const optionalFields = {
    blocked_reason: patch.blocked_reason,
    proposal_context_bundle_digest:
      patch.proposal_context_bundle_digest ?? previous.proposal_context_bundle_digest,
    review_context_bundle_digest:
      patch.review_context_bundle_digest ?? previous.review_context_bundle_digest,
    current_proposal_digest: patch.current_proposal_digest ?? previous.current_proposal_digest,
    current_validation_digest:
      patch.current_validation_digest ?? previous.current_validation_digest,
    current_review_digest: patch.current_review_digest ?? previous.current_review_digest,
    current_risk_assessment_digest:
      patch.current_risk_assessment_digest ?? previous.current_risk_assessment_digest,
    current_approval_request_id:
      patch.current_approval_request_id ?? previous.current_approval_request_id,
    applied_approval_decision_id:
      patch.applied_approval_decision_id ?? previous.applied_approval_decision_id,
  } as const;
  for (const [field, value] of Object.entries(optionalFields)) {
    if (value !== undefined) record[field] = value;
  }
  return sealRecordEnvelope(record) as unknown as CaptureSessionRecord;
}

function normalizeDraftText(value: string): string {
  return value.normalize("NFC").trim();
}

interface NormalizedQuestionDraft {
  readonly source: ClarificationQuestionRecord["source"];
  readonly target_kind: ClarificationQuestionRecord["target_kind"];
  readonly target_id?: string;
  readonly missing_dimension: string;
  readonly question: string;
  readonly options?: readonly ClarificationOption[];
  readonly required: boolean;
}

function validateDraft(draft: ClarificationQuestionDraft): void {
  if (!CAPTURE_QUESTION_SOURCES.includes(draft.source)) {
    throw new CaptureRecordError("invalid_question", `unknown question source: ${draft.source}`);
  }
  if (!CAPTURE_QUESTION_TARGET_KINDS.includes(draft.target_kind)) {
    throw new CaptureRecordError(
      "invalid_question",
      `unknown question target kind: ${draft.target_kind}`,
    );
  }
  if (normalizeDraftText(draft.question).length === 0) {
    throw new CaptureRecordError("invalid_question", "question text must not be empty");
  }
  if (normalizeDraftText(draft.missing_dimension).length === 0) {
    throw new CaptureRecordError("invalid_question", "missing_dimension must not be empty");
  }
  if (draft.options !== undefined && draft.options.length === 0) {
    throw new CaptureRecordError("invalid_question", "an empty options list is not a question");
  }
}

/** Identity material of a question; `source` is provenance, not identity. */
function questionDedupKey(draft: NormalizedQuestionDraft): string {
  return contentDigest({
    target_kind: draft.target_kind,
    target_id: draft.target_id ?? null,
    missing_dimension: draft.missing_dimension,
    question: draft.question,
    options: draft.options ?? null,
    required: draft.required,
  });
}

/**
 * Normalize, deduplicate and stably sort question drafts (design 7.3). The
 * same semantic question asked from several sources collapses into one
 * record; question identity binds the session, round and canonical content,
 * so a re-asked question in a later round mints a new record instead of
 * rewriting the old one.
 */
export function createClarificationQuestionRecords(input: {
  readonly session_id: string;
  readonly round: number;
  readonly drafts: readonly ClarificationQuestionDraft[];
}): ClarificationQuestionRecord[] {
  if (!Number.isInteger(input.round) || input.round < 1) {
    throw new CaptureRecordError("invalid_round", "clarification round must be a positive integer");
  }
  const normalized: NormalizedQuestionDraft[] = input.drafts.map((draft) => {
    validateDraft(draft);
    return {
      source: draft.source,
      target_kind: draft.target_kind,
      ...(draft.target_id === undefined ? {} : { target_id: draft.target_id }),
      missing_dimension: normalizeDraftText(draft.missing_dimension),
      question: normalizeDraftText(draft.question),
      ...(draft.options === undefined ? {} : { options: draft.options }),
      required: draft.required,
    };
  });
  const byKey = new Map<string, NormalizedQuestionDraft>();
  for (const draft of normalized) {
    const key = questionDedupKey(draft);
    const existing = byKey.get(key);
    // Deterministic survivor: the lexicographically smallest source wins, so
    // the surviving record never depends on handler emission order.
    if (existing === undefined || draft.source < existing.source) {
      byKey.set(key, draft);
    }
  }
  const unique = [...byKey.values()].sort((left, right) => {
    const leftKey = questionDedupKey(left);
    const rightKey = questionDedupKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return unique.map((draft) => {
    const question_id = domainRecordId({
      domain_tag: "clarification_question",
      id_prefix: "clarification-question",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        session_id: input.session_id,
        round: input.round,
        content_key: questionDedupKey(draft),
      },
    });
    const content_digest = contentDigest({
      session_id: input.session_id,
      round: input.round,
      source: draft.source,
      target_kind: draft.target_kind,
      target_id: draft.target_id ?? null,
      missing_dimension: draft.missing_dimension,
      question: draft.question,
      options: draft.options ?? null,
      required: draft.required,
    });
    return sealRecordEnvelope({
      protocol_version: PROTOCOL_1_1_VERSION,
      record_kind: "clarification_question" as const,
      question_id,
      session_id: input.session_id,
      round: input.round,
      source: draft.source,
      target_kind: draft.target_kind,
      ...(draft.target_id === undefined ? {} : { target_id: draft.target_id }),
      missing_dimension: draft.missing_dimension,
      question: draft.question,
      ...(draft.options === undefined ? {} : { options: [...draft.options] }),
      required: draft.required,
      status: "open" as const,
      content_digest,
    });
  });
}

/**
 * An answer binds the exact question, the submitting actor and the session
 * digest the caller saw. Identity derives from question + canonical value +
 * actor, so a replayed submission is a byte-identical no-op while a changed
 * answer is a new record (old answers are never overwritten).
 */
export function createClarificationAnswerRecord(input: {
  readonly session_id: string;
  readonly question: ClarificationQuestionRecord;
  readonly answer_kind: ClarificationAnswerRecord["answer_kind"];
  readonly value: unknown;
  readonly actor: string;
  readonly expected_session_digest: string;
}): ClarificationAnswerRecord {
  assertDigest("invalid_digest", input.expected_session_digest, "expected_session_digest");
  if (!CAPTURE_ANSWER_KINDS.includes(input.answer_kind)) {
    throw new CaptureRecordError("invalid_answer", `unknown answer kind: ${input.answer_kind}`);
  }
  if (input.question.session_id !== input.session_id) {
    throw new CaptureRecordError(
      "invalid_answer",
      "answer session does not match the question session",
    );
  }
  if (input.answer_kind === "free_text" && typeof input.value !== "string") {
    throw new CaptureRecordError("invalid_answer", "free_text answers must be strings");
  }
  if (input.answer_kind === "selected_option") {
    const options = input.question.options ?? [];
    if (typeof input.value !== "string" || !options.some((o) => o.option_id === input.value)) {
      throw new CaptureRecordError(
        "invalid_answer",
        "selected_option answers must reference one of the question's options",
      );
    }
  }
  if (input.actor.trim().length === 0 || input.actor.length > 200) {
    throw new CaptureRecordError("invalid_answer", "actor must be a non-empty actor identity");
  }
  const content_digest = contentDigest({
    question_id: input.question.question_id,
    answer_kind: input.answer_kind,
    value: input.value ?? null,
    actor: input.actor,
  });
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "clarification_answer" as const,
    answer_id: domainRecordId({
      domain_tag: "clarification_answer",
      id_prefix: "clarification-answer",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { content_digest },
    }),
    session_id: input.session_id,
    question_id: input.question.question_id,
    answer_kind: input.answer_kind,
    value: input.value as never,
    actor: input.actor,
    expected_session_digest: input.expected_session_digest,
    content_digest,
  });
}

/**
 * The committed invocation intent (design 7.2, 11.3). One identity per
 * session revision and purpose: after a crash the resume path finds the
 * persisted record and reuses it, so a retried stage never forks a second
 * invocation for the same committed inputs.
 */
export function createCaptureInvocationRecord(input: {
  readonly session: CaptureSessionRecord;
  readonly purpose: CaptureInvocationPurpose;
  readonly binding_digests: readonly string[];
}): CaptureInvocationRecord {
  if (!CAPTURE_INVOCATION_PURPOSES.includes(input.purpose)) {
    throw new CaptureRecordError("invalid_invocation", `unknown purpose: ${input.purpose}`);
  }
  const bindingDigests = canonicalStringSet([...input.binding_digests]);
  if (bindingDigests.length !== input.binding_digests.length) {
    throw new CaptureRecordError(
      "invalid_invocation",
      "binding digests must be unique per invocation",
    );
  }
  for (const digest of bindingDigests) {
    assertDigest("invalid_digest", digest, "binding_digests");
  }
  const invocation_key = contentDigest({
    session_id: input.session.session_id,
    session_revision: input.session.revision,
    purpose: input.purpose,
    session_digest: input.session.record_digest,
    binding_digests: bindingDigests,
  });
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "capture_invocation" as const,
    invocation_id: domainRecordId({
      domain_tag: "capture_invocation",
      id_prefix: "capture-invocation",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        session_id: input.session.session_id,
        session_revision: input.session.revision,
        purpose: input.purpose,
      },
    }),
    session_id: input.session.session_id,
    session_revision: input.session.revision,
    session_digest: input.session.record_digest,
    workflow_operation_id: input.session.workflow_operation_id,
    purpose: input.purpose,
    invocation_key,
    binding_digests: bindingDigests,
  });
}

/** Sealed restart marker for one committed session revision. */
export function createCaptureCheckpointRecord(
  session: CaptureSessionRecord,
): CaptureCheckpointRecord {
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "capture_checkpoint" as const,
    checkpoint_id: domainRecordId({
      domain_tag: "capture_checkpoint",
      id_prefix: "capture-checkpoint",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { session_id: session.session_id, session_revision: session.revision },
    }),
    session_id: session.session_id,
    session_revision: session.revision,
    state: session.state,
    session_digest: session.record_digest,
  });
}

/**
 * The typed blocker committed with every blocked revision. `resume_state` is
 * where an explicit resume re-enters after the blocking condition clears; it
 * is never a terminal state and never `blocked` itself.
 */
export function createCaptureBlockerRecord(input: {
  readonly session: CaptureSessionRecord;
  readonly reason: CaptureBlockReason;
  readonly resume_state: CaptureState;
  readonly detail: string;
}): CaptureBlockerRecord {
  if (isTerminalCaptureState(input.resume_state) || input.resume_state === "blocked") {
    throw new CaptureRecordError(
      "invalid_blocker",
      `blocker resume_state must be a resumable state, got ${input.resume_state}`,
    );
  }
  if (input.detail.trim().length === 0) {
    throw new CaptureRecordError("invalid_blocker", "blocker detail must not be empty");
  }
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "capture_blocker" as const,
    blocker_id: domainRecordId({
      domain_tag: "capture_blocker",
      id_prefix: "capture-blocker",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        session_id: input.session.session_id,
        session_revision: input.session.revision,
        reason: input.reason,
      },
    }),
    session_id: input.session.session_id,
    session_revision: input.session.revision,
    session_digest: input.session.record_digest,
    reason: input.reason,
    resume_state: input.resume_state,
    detail: input.detail,
  });
}

/**
 * The full session invariant enforced on every store read and write: schema
 * fields plus the conditional blocked-reason rule and a known state.
 */
export function assertCaptureSessionRecord(record: CaptureSessionRecord): void {
  if (record.record_kind !== "capture_session") {
    throw new CaptureRecordError("invalid_record", "not a capture session record");
  }
  if (!isCaptureState(record.state)) {
    throw new CaptureRecordError(
      "invalid_record",
      `unknown capture state: ${String(record.state)}`,
    );
  }
  assertCaptureStateFields(record.state, record.blocked_reason);
}
