import { domainRecordId } from "../identity/record-id.js";
import { contentDigest } from "../identity/digest.js";
import { readCaptureModelProviderBindings } from "../profile/store.js";
import { createManualReviewInputRecord, ReviewRecordError } from "../review/records.js";
import { appendManualReviewInputRecord, readManualReviewInputs } from "../review/store.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import type {
  CaptureBlockReason,
  CaptureBudgetUse,
  CaptureInvocationPurpose,
  CaptureInvocationRecord,
  CaptureSessionRecord,
  CaptureState,
  ClarificationQuestionRecord,
} from "../schema/capture.js";
import type {
  ApplyApprovalDecisionCommand,
  CancelCaptureCommand,
  CaptureApprovalDecisionView,
  CaptureCommand,
  CaptureFailureKind,
  CaptureOutcome,
  CaptureStageHandlers,
  CaptureStageRequest,
  CaptureStageResult,
  RequestPrdRevisionCommand,
  ResumeCaptureCommand,
  StartCaptureCommand,
  SubmitClarificationAnswersCommand,
  SubmitManualReviewInputCommand,
} from "./commands.js";
import {
  CaptureRecordError,
  createCaptureBlockerRecord,
  createCaptureCheckpointRecord,
  createCaptureInvocationRecord,
  createCaptureSessionRecord,
  createClarificationAnswerRecord,
  createClarificationQuestionRecords,
  reviseCaptureSessionRecord,
  type CaptureSessionRevisionPatch,
  type ClarificationQuestionDraft,
} from "./records.js";
import { isTerminalCaptureState } from "./states.js";
import {
  appendCaptureAnswerRecord,
  appendCaptureBlockerRecord,
  appendCaptureCheckpointRecord,
  appendCaptureInvocationRecord,
  appendCaptureQuestionRecord,
  appendCaptureSessionRecord,
  readCaptureAnswers,
  readCaptureBlockers,
  readCaptureInvocations,
  readCaptureQuestions,
  readCaptureSessionRevisions,
  readLatestCaptureSession,
} from "./store.js";

/**
 * PrdCaptureCoordinator (intent-to-prd design 5.1/7): the single advance
 * interface shared by CLI, Dashboard and Orchestrator. It owns the state
 * machine, canonical records, checkpoints, the invocation barrier (every
 * model-call stage commits its Operation-bound session revision, invocation
 * intent and Capture-scope binding digests before the handler runs) and
 * ApprovalDecision consumption. It holds no authoritative in-memory state:
 * every command reloads from the append-only store, so a refresh, a process
 * restart or an alternating CLI/Dashboard client always resumes from the
 * committed bytes alone.
 *
 * Stage handlers are the only seam: Tasks 5-7 wrap the real context,
 * proposal, review and risk implementations into them. A handler receives
 * only already-committed facts and returns a stage-local result; it never
 * writes the store and never chooses the next state.
 */
export interface CaptureBudgetLimits {
  readonly maxClarificationRounds?: number;
}

/** Deterministic fault-injection points for crash/recovery tests. */
export type CaptureFaultPoint = "invocation.persisted" | "decision.consumed";

export interface CaptureProfileResolution {
  readonly drift: "proposal" | "review";
}

export interface CaptureCoordinatorDeps {
  readonly projectRoot: string;
  readonly handlers?: CaptureStageHandlers;
  readonly readApprovalDecision?: (
    requestId: string,
    decisionId: string,
  ) => CaptureApprovalDecisionView | undefined;
  readonly resolveProfileDecision?: (
    session: CaptureSessionRecord,
  ) => CaptureProfileResolution | undefined;
  readonly budget?: CaptureBudgetLimits;
  /**
   * Standard/Governed declare Capture-scope bindings as required (design
   * 11.1); when set, a session whose ProfileDecision has no committed
   * binding record fails closed instead of running unbound.
   */
  readonly requireCaptureBindings?: boolean;
  readonly failpoint?: (point: CaptureFaultPoint) => void;
}

export interface PrdCaptureCoordinator {
  advance(command: CaptureCommand): Promise<CaptureOutcome>;
  current(sessionId: string): CaptureSessionRecord | undefined;
}

const DIGEST_REGEX = /^[a-f0-9]{64}$/u;
const MAX_DRIVE_STEPS = 64;

type HandlerStage =
  | "context_compiling"
  | "proposing"
  | "validating"
  | "reviewing"
  | "risk_assessing"
  | "approval_brief"
  | "accept";

const ALLOWED_STAGE_RESULTS: Readonly<Record<HandlerStage, readonly CaptureStageResult["kind"][]>> =
  {
    context_compiling: ["context_compiled", "stage_failed"],
    proposing: ["proposal_ready", "clarification_required", "stage_failed"],
    validating: [
      "validation_passed",
      "validation_revision_required",
      "clarification_required",
      "stage_failed",
    ],
    reviewing: ["review_completed", "review_input_required", "stage_failed"],
    risk_assessing: ["risk_stable", "risk_upgrade_required", "risk_denied", "stage_failed"],
    approval_brief: ["approval_brief_ready", "stage_failed"],
    accept: ["acceptance_committed", "stage_failed"],
  };

function failed(
  kind: CaptureFailureKind,
  message: string,
  session?: CaptureSessionRecord,
): CaptureOutcome {
  return { status: "failed", kind, message, ...(session === undefined ? {} : { session }) };
}

/**
 * The deterministic approval request identity for the session revision that
 * will present the request. Exported so the approval_brief stage can bind the
 * exact request the brief will be presented with.
 */
export function deriveCaptureApprovalRequestId(
  session: CaptureSessionRecord,
  nextRevision: number,
): string {
  return domainRecordId({
    domain_tag: "capture_approval_request",
    id_prefix: "approval-request",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: {
      session_id: session.session_id,
      session_revision: nextRevision,
      object_digest: session.current_proposal_digest ?? null,
    },
  });
}

export function createPrdCaptureCoordinator(deps: CaptureCoordinatorDeps): PrdCaptureCoordinator {
  const root = deps.projectRoot;
  const handlers = deps.handlers ?? {};
  const maxRounds = deps.budget?.maxClarificationRounds ?? Number.POSITIVE_INFINITY;

  // --- committed-fact helpers ------------------------------------------

  function revisionsOf(sessionId: string): CaptureSessionRecord[] {
    return readCaptureSessionRevisions(root, sessionId);
  }

  function latest(sessionId: string): CaptureSessionRecord | undefined {
    return readLatestCaptureSession(root, sessionId);
  }

  /** Every Capture-scope binding digest committed for this session's ProfileDecision. */
  function bindingDigestsFor(session: CaptureSessionRecord): string[] {
    return readCaptureModelProviderBindings(root)
      .filter((binding) => binding.profile_decision_digest === session.profile_decision_digest)
      .map((binding) => binding.record_digest)
      .sort();
  }

  /** Every previously consumed binding digest is still present in `current`. */
  function bindingsCover(current: readonly string[], required: readonly string[]): boolean {
    const set = new Set(current);
    return required.every((digest) => set.has(digest));
  }

  function budgetUseFor(sessionId: string, round: number): CaptureBudgetUse {
    const invocations = readCaptureInvocations(root, sessionId);
    return {
      clarification_rounds: round,
      proposal_invocations: invocations.filter((i) => i.purpose === "proposal").length,
      review_invocations: invocations.filter((i) => i.purpose === "review").length,
    };
  }

  /**
   * Append the next session revision plus its checkpoint. The store enforces
   * monotonic revisions and the supersedes chain; identical re-appends are
   * no-ops so a crashed drive step can be replayed safely.
   */
  function transition(
    session: CaptureSessionRecord,
    patch: CaptureSessionRevisionPatch,
  ): CaptureSessionRecord {
    const round = patch.round ?? session.round;
    const revision = reviseCaptureSessionRecord(
      session,
      patch,
      budgetUseFor(session.session_id, round),
    );
    appendCaptureSessionRecord(root, revision);
    appendCaptureCheckpointRecord(root, createCaptureCheckpointRecord(revision));
    return revision;
  }

  /** Blocked revisions always come with their typed blocker record. */
  function block(
    session: CaptureSessionRecord,
    reason: CaptureBlockReason,
    resumeState: CaptureState,
    detail: string,
  ): CaptureOutcome {
    const revision = reviseCaptureSessionRecord(
      session,
      { state: "blocked", blocked_reason: reason },
      budgetUseFor(session.session_id, session.round),
    );
    const blocker = createCaptureBlockerRecord({
      session: revision,
      reason,
      resume_state: resumeState,
      detail,
    });
    appendCaptureBlockerRecord(root, blocker);
    appendCaptureSessionRecord(root, revision);
    appendCaptureCheckpointRecord(root, createCaptureCheckpointRecord(revision));
    return { status: "blocked", session: revision, blocker };
  }

  /**
   * The invocation barrier (design 7.2, 11.3): before any model-call stage
   * runs, the invocation intent — binding the workflow operation, the exact
   * session revision and every committed Capture-scope binding digest — is
   * persisted. An existing record for the same revision/purpose is reused
   * (crash-safe idempotency); a changed binding set is drift and fails closed.
   */
  function ensureInvocation(
    session: CaptureSessionRecord,
    purpose: CaptureInvocationPurpose,
  ): CaptureInvocationRecord | CaptureOutcome {
    const bindings = bindingDigestsFor(session);
    if (deps.requireCaptureBindings === true && bindings.length === 0) {
      return failed(
        "binding_missing",
        "no Capture-scope model provider binding is committed for this profile decision",
        session,
      );
    }
    const prior = readCaptureInvocations(root, session.session_id);
    const existing = prior.find(
      (candidate) =>
        candidate.session_revision === session.revision && candidate.purpose === purpose,
    );
    if (existing !== undefined) {
      if (
        existing.session_digest !== session.record_digest ||
        !bindingsCover(bindings, existing.binding_digests)
      ) {
        return failed(
          "binding_drift",
          "persisted invocation bindings no longer match the committed Capture-scope bindings",
          session,
        );
      }
      return existing;
    }
    // Drift means a binding an earlier invocation consumed disappeared or
    // changed; adding a new binding for a purpose that has not run yet is the
    // legitimate "configure the provider, then resume" recovery path.
    const priorDigests = [...new Set(prior.flatMap((record) => record.binding_digests))];
    if (!bindingsCover(bindings, priorDigests)) {
      return failed(
        "binding_drift",
        "Capture-scope bindings changed mid-session; dependent stages must not proceed",
        session,
      );
    }
    const invocation = createCaptureInvocationRecord({
      session,
      purpose,
      binding_digests: bindings,
    });
    appendCaptureInvocationRecord(root, invocation);
    deps.failpoint?.("invocation.persisted");
    return invocation;
  }

  /** Drift guard for approval-time revalidation (defer resume, decision consumption). */
  function checkBindingDrift(session: CaptureSessionRecord): CaptureOutcome | undefined {
    const prior = readCaptureInvocations(root, session.session_id);
    if (prior.length === 0) return undefined;
    const current = bindingDigestsFor(session);
    const priorDigests = [...new Set(prior.flatMap((record) => record.binding_digests))];
    if (!bindingsCover(current, priorDigests)) {
      return failed(
        "binding_drift",
        "Capture-scope bindings drifted since the proposal round; approval is invalidated",
        session,
      );
    }
    return undefined;
  }

  function stageRequest(
    session: CaptureSessionRecord,
    invocation?: CaptureInvocationRecord,
  ): CaptureStageRequest {
    return {
      session,
      ...(invocation === undefined ? {} : { invocation }),
      questions: readCaptureQuestions(root, session.session_id),
      answers: readCaptureAnswers(root, session.session_id),
    };
  }

  function validateResult(
    stage: HandlerStage,
    result: CaptureStageResult,
    session: CaptureSessionRecord,
  ): CaptureOutcome | undefined {
    if (!ALLOWED_STAGE_RESULTS[stage].includes(result.kind)) {
      return failed(
        "invalid_stage_result",
        `stage ${stage} returned ${result.kind}, which it may not return`,
        session,
      );
    }
    const digestFields: Record<string, string | undefined> = {
      ...(result.kind === "context_compiled" ? { bundle_digest: result.bundle_digest } : {}),
      ...(result.kind === "proposal_ready" ? { proposal_digest: result.proposal_digest } : {}),
      ...(result.kind === "validation_passed"
        ? { validation_digest: result.validation_digest }
        : {}),
      ...(result.kind === "review_completed" ? { review_digest: result.review_digest } : {}),
      ...(result.kind === "risk_stable"
        ? { risk_assessment_digest: result.risk_assessment_digest }
        : {}),
      ...(result.kind === "approval_brief_ready" ? { brief_digest: result.brief_digest } : {}),
      ...(result.kind === "acceptance_committed"
        ? {
            accepted_prd_digest: result.accepted_prd_digest,
            requirement_baseline_digest: result.requirement_baseline_digest,
          }
        : {}),
    };
    for (const [field, value] of Object.entries(digestFields)) {
      if (typeof value !== "string" || !DIGEST_REGEX.test(value)) {
        return failed(
          "invalid_stage_result",
          `stage ${stage} returned a malformed ${field}`,
          session,
        );
      }
    }
    if (result.kind === "risk_stable" && result.approval_route === "policy_auto") {
      if (typeof result.policy_actor !== "string" || result.policy_actor.trim().length === 0) {
        return failed(
          "invalid_stage_result",
          "policy auto approval requires a non-empty policy actor",
          session,
        );
      }
    }
    if (
      (result.kind === "clarification_required" && result.questions.length === 0) ||
      (result.kind === "review_completed" &&
        result.verdict === "clarify" &&
        (result.questions === undefined || result.questions.length === 0))
    ) {
      return failed(
        "invalid_stage_result",
        `stage ${stage} reported clarification without questions`,
        session,
      );
    }
    return undefined;
  }

  /** Issue a clarification round: budget check, question records, CR revision. */
  function issueQuestions(
    session: CaptureSessionRecord,
    drafts: readonly ClarificationQuestionDraft[],
    interruptedState: CaptureState,
  ): CaptureOutcome {
    const nextRound = session.round + 1;
    if (nextRound > maxRounds) {
      return block(
        session,
        "capture_budget_exhausted",
        interruptedState,
        `clarification round ${String(nextRound)} exceeds the capture budget`,
      );
    }
    const questions = createClarificationQuestionRecords({
      session_id: session.session_id,
      round: nextRound,
      drafts,
    });
    for (const question of questions) {
      appendCaptureQuestionRecord(root, question);
    }
    const revision = transition(session, {
      state: "clarification_required",
      round: nextRound,
      pending_question_ids: questions.map((question) => question.question_id),
    });
    return { status: "awaiting_answers", session: revision, questions };
  }

  function openQuestions(session: CaptureSessionRecord): ClarificationQuestionRecord[] {
    const answered = new Set(
      readCaptureAnswers(root, session.session_id).map((answer) => answer.question_id),
    );
    const questions = readCaptureQuestions(root, session.session_id);
    return session.pending_question_ids
      .map((questionId) => questions.find((question) => question.question_id === questionId))
      .filter(
        (question): question is ClarificationQuestionRecord =>
          question !== undefined && !answered.has(question.question_id),
      );
  }

  function awaitingAnswersOutcome(session: CaptureSessionRecord): CaptureOutcome {
    return { status: "awaiting_answers", session, questions: openQuestions(session) };
  }

  function awaitingApprovalOutcome(session: CaptureSessionRecord): CaptureOutcome {
    if (
      session.current_approval_request_id === undefined ||
      session.current_proposal_digest === undefined
    ) {
      return failed(
        "missing_approval_object",
        "approval_required without a bound proposal digest and request id",
        session,
      );
    }
    return {
      status: "awaiting_approval",
      session,
      approval_request_id: session.current_approval_request_id,
      approval_object_digest: session.current_proposal_digest,
    };
  }

  function deriveApprovalRequestId(session: CaptureSessionRecord, nextRevision: number): string {
    return deriveCaptureApprovalRequestId(session, nextRevision);
  }

  /**
   * The context purpose is committed in the invocation record, not the
   * session; after a crash it is re-derived from the previous revision (or,
   * for profile-decision resumes, deterministically re-resolved).
   */
  function contextPurpose(
    session: CaptureSessionRecord,
    revisions: readonly CaptureSessionRecord[],
  ): "proposal" | "review" | CaptureOutcome {
    const previous = revisions.at(-2);
    switch (previous?.state) {
      case "validating":
        return "review";
      case "intent_received":
      case "clarification_required":
      case "revision_required":
        return "proposal";
      case "profile_decision_required": {
        const resolution = deps.resolveProfileDecision?.(session);
        if (resolution === undefined) {
          return failed(
            "profile_resolution_unavailable",
            "cannot re-derive the context purpose without a profile decision resolution",
            session,
          );
        }
        return resolution.drift;
      }
      default:
        return failed(
          "invalid_transition",
          "context_compiling revision does not follow a derivable predecessor",
          session,
        );
    }
  }

  async function runHandler(
    stage: HandlerStage,
    session: CaptureSessionRecord,
    invocation?: CaptureInvocationRecord,
    approval?: CaptureStageRequest["approval"],
  ): Promise<CaptureStageResult | CaptureOutcome> {
    const handler =
      stage === "context_compiling"
        ? handlers.compileContext
        : stage === "proposing"
          ? handlers.propose
          : stage === "validating"
            ? handlers.validate
            : stage === "reviewing"
              ? handlers.review
              : stage === "risk_assessing"
                ? handlers.assessRisk
                : stage === "approval_brief"
                  ? handlers.approvalBrief
                  : handlers.accept;
    if (handler === undefined) {
      return failed(
        "stage_unavailable",
        `no handler registered for capture stage ${stage}`,
        session,
      );
    }
    const request = stageRequest(session, invocation);
    const result = await handler(approval === undefined ? request : { ...request, approval });
    const invalid = validateResult(stage, result, session);
    return invalid ?? result;
  }

  /**
   * Run the atomic accepted transaction (T7) for an approved decision. The
   * returned outcome is a failure to surface to the caller; on success the
   * handler committed the accepted PRD, baseline and graph records.
   */
  async function runAcceptance(
    session: CaptureSessionRecord,
    approval: NonNullable<CaptureStageRequest["approval"]>,
  ): Promise<CaptureOutcome | undefined> {
    const result = await runHandler("accept", session, undefined, approval);
    if ("status" in result) return result;
    if (result.kind === "stage_failed") {
      return failed("stage_failed", result.failure.summary, session);
    }
    if (result.kind !== "acceptance_committed") {
      return failed("invalid_stage_result", "unexpected accept stage result", session);
    }
    return undefined;
  }

  /** The main path driver (design 7.2); stops at the first waiting point. */
  async function drive(sessionId: string): Promise<CaptureOutcome> {
    for (let steps = 0; steps < MAX_DRIVE_STEPS; steps += 1) {
      const revisions = revisionsOf(sessionId);
      const session = revisions.at(-1);
      if (session === undefined) {
        return failed("session_not_found", `unknown capture session: ${sessionId}`);
      }
      switch (session.state) {
        case "intent_received": {
          transition(session, { state: "context_compiling" });
          continue;
        }
        case "context_compiling": {
          const purpose = contextPurpose(session, revisions);
          if (typeof purpose !== "string") return purpose;
          const invocation = ensureInvocation(
            session,
            purpose === "proposal" ? "context_proposal" : "context_review",
          );
          if (!("invocation_id" in invocation)) return invocation;
          const result = await runHandler("context_compiling", session, invocation);
          if ("status" in result) return result;
          if (result.kind === "stage_failed") {
            return failed("stage_failed", result.failure.summary, session);
          }
          if (result.kind !== "context_compiled") {
            return failed("invalid_stage_result", "unexpected context stage result", session);
          }
          transition(session, {
            state: purpose === "proposal" ? "proposing" : "reviewing",
            ...(purpose === "proposal"
              ? { proposal_context_bundle_digest: result.bundle_digest }
              : { review_context_bundle_digest: result.bundle_digest }),
          });
          continue;
        }
        case "proposing": {
          const invocation = ensureInvocation(session, "proposal");
          if (!("invocation_id" in invocation)) return invocation;
          const result = await runHandler("proposing", session, invocation);
          if ("status" in result) return result;
          if (result.kind === "stage_failed") {
            return failed("stage_failed", result.failure.summary, session);
          }
          if (result.kind === "clarification_required") {
            return issueQuestions(session, result.questions, "proposing");
          }
          if (result.kind !== "proposal_ready") {
            return failed("invalid_stage_result", "unexpected proposal stage result", session);
          }
          transition(session, {
            state: "validating",
            current_proposal_digest: result.proposal_digest,
          });
          continue;
        }
        case "validating": {
          const result = await runHandler("validating", session);
          if ("status" in result) return result;
          if (result.kind === "stage_failed") {
            return failed("stage_failed", result.failure.summary, session);
          }
          if (result.kind === "clarification_required") {
            return issueQuestions(session, result.questions, "validating");
          }
          if (result.kind === "validation_revision_required") {
            transition(session, { state: "revision_required" });
            continue;
          }
          if (result.kind !== "validation_passed") {
            return failed("invalid_stage_result", "unexpected validation stage result", session);
          }
          transition(session, {
            state: "context_compiling",
            current_validation_digest: result.validation_digest,
          });
          continue;
        }
        case "clarification_required":
          return awaitingAnswersOutcome(session);
        case "reviewing": {
          if (handlers.review === undefined) {
            return block(
              session,
              "review_provider_required",
              "reviewing",
              "no review provider configured and manual review not selected",
            );
          }
          const invocation = ensureInvocation(session, "review");
          if (!("invocation_id" in invocation)) return invocation;
          const result = await runHandler("reviewing", session, invocation);
          if ("status" in result) return result;
          if (result.kind === "stage_failed") {
            return failed("stage_failed", result.failure.summary, session);
          }
          if (result.kind === "review_input_required") {
            transition(session, { state: "review_input_required" });
            continue;
          }
          if (result.kind !== "review_completed") {
            return failed("invalid_stage_result", "unexpected review stage result", session);
          }
          if (result.verdict === "accept") {
            transition(session, {
              state: "risk_assessing",
              current_review_digest: result.review_digest,
            });
            continue;
          }
          if (result.verdict === "revise") {
            transition(session, {
              state: "revision_required",
              current_review_digest: result.review_digest,
            });
            continue;
          }
          if (result.verdict === "clarify") {
            return issueQuestions(session, result.questions ?? [], "reviewing");
          }
          return block(
            session,
            "review_blocked",
            "reviewing",
            `review reported a blocking verdict (review ${result.review_digest})`,
          );
        }
        case "review_input_required":
          return { status: "review_input_required", session };
        case "risk_assessing": {
          const result = await runHandler("risk_assessing", session);
          if ("status" in result) return result;
          if (result.kind === "stage_failed") {
            return failed("stage_failed", result.failure.summary, session);
          }
          if (result.kind === "risk_upgrade_required") {
            transition(session, { state: "profile_decision_required" });
            continue;
          }
          if (result.kind === "risk_denied") {
            return block(
              session,
              "risk_policy_denied",
              "risk_assessing",
              "the capture policy denied this risk level",
            );
          }
          if (result.kind !== "risk_stable") {
            return failed("invalid_stage_result", "unexpected risk stage result", session);
          }
          if (session.current_proposal_digest === undefined) {
            return failed(
              "missing_approval_object",
              "cannot require approval without a current proposal digest",
              session,
            );
          }
          if (result.approval_route === "policy_auto") {
            // Policy auto approval (design 15): the Coordinator generates the
            // decision inside the accepted transaction with the versioned
            // Policy identity as actor — never an external shortcut. The
            // request revision is committed first so the accept stage reads
            // the same bound digests a human approval would.
            if (handlers.accept === undefined) {
              return failed(
                "stage_unavailable",
                "policy auto approval requires the accept stage to commit the accepted PRD",
                session,
              );
            }
            const policyActor = result.policy_actor as string;
            const autoRequestId = deriveApprovalRequestId(session, session.revision + 1);
            const autoDecisionId = domainRecordId({
              domain_tag: "capture_auto_approval_decision",
              id_prefix: "capture-auto-approval",
              protocol_version: PROTOCOL_1_1_VERSION,
              canonical_input: {
                session_id: session.session_id,
                session_revision: session.revision + 1,
                object_digest: session.current_proposal_digest,
                risk_assessment_digest: result.risk_assessment_digest,
              },
            });
            const autoDecisionDigest = contentDigest({
              decision_id: autoDecisionId,
              request_id: autoRequestId,
              actor: policyActor,
              decision: "approve",
              object_digest: session.current_proposal_digest,
            });
            const requested = transition(session, {
              state: "approval_required",
              current_risk_assessment_digest: result.risk_assessment_digest,
              current_approval_request_id: autoRequestId,
            });
            const acceptFailure = await runAcceptance(requested, {
              request_id: autoRequestId,
              decision_id: autoDecisionId,
              actor: policyActor,
              decision_digest: autoDecisionDigest,
            });
            if (acceptFailure !== undefined) return acceptFailure;
            transition(requested, {
              state: "accepted",
              applied_approval_decision_id: autoDecisionId,
            });
            continue;
          }
          if (handlers.approvalBrief !== undefined) {
            // Commit the approval_required revision first so the brief stage
            // reads the same bound digests (risk assessment, request id) the
            // human approver will see; a brief failure blocks from there.
            const requested = transition(session, {
              state: "approval_required",
              current_risk_assessment_digest: result.risk_assessment_digest,
              current_approval_request_id: deriveApprovalRequestId(session, session.revision + 1),
            });
            const briefInvocation = ensureInvocation(requested, "approval_brief");
            if (!("invocation_id" in briefInvocation)) return briefInvocation;
            const briefResult = await runHandler("approval_brief", requested, briefInvocation);
            if ("status" in briefResult) return briefResult;
            if (briefResult.kind === "stage_failed") {
              if (
                briefResult.failure.code === "provider_required" ||
                briefResult.failure.code === "provider_unavailable"
              ) {
                return block(
                  requested,
                  "approval_brief_provider_required",
                  "risk_assessing",
                  briefResult.failure.summary,
                );
              }
              return failed("stage_failed", briefResult.failure.summary, requested);
            }
            if (briefResult.kind !== "approval_brief_ready") {
              return failed(
                "invalid_stage_result",
                "unexpected approval brief stage result",
                requested,
              );
            }
            continue;
          }
          const requestId = deriveApprovalRequestId(session, session.revision + 1);
          transition(session, {
            state: "approval_required",
            current_risk_assessment_digest: result.risk_assessment_digest,
            current_approval_request_id: requestId,
          });
          continue;
        }
        case "revision_required": {
          const previous = revisions.at(-2);
          // Gate/review-driven revision loops continue automatically; a human
          // reject waits for an explicit RequestPrdRevisionCommand.
          if (previous?.state === "validating" || previous?.state === "reviewing") {
            transition(session, { state: "context_compiling" });
            continue;
          }
          return { status: "revision_required", session };
        }
        case "profile_decision_required": {
          const resolution = deps.resolveProfileDecision?.(session);
          if (resolution === undefined) {
            return { status: "awaiting_profile_decision", session };
          }
          transition(session, { state: "context_compiling" });
          continue;
        }
        case "approval_required":
          return awaitingApprovalOutcome(session);
        case "approval_deferred":
          return { status: "approval_deferred", session };
        case "blocked": {
          const blocker = readCaptureBlockers(root, session.session_id)
            .filter((candidate) => candidate.session_revision <= session.revision)
            .sort((left, right) => right.session_revision - left.session_revision)
            .at(0);
          if (blocker === undefined) {
            return failed(
              "invalid_transition",
              "blocked session without a committed blocker record",
              session,
            );
          }
          return { status: "blocked", session, blocker };
        }
        case "accepted":
          return { status: "accepted", session };
        case "cancelled":
          return { status: "cancelled", session };
      }
    }
    throw new Error(`capture drive exceeded ${String(MAX_DRIVE_STEPS)} steps; handler loop?`);
  }

  // --- commands ---------------------------------------------------------

  async function start(command: StartCaptureCommand): Promise<CaptureOutcome> {
    let session: CaptureSessionRecord;
    try {
      session = createCaptureSessionRecord(command);
    } catch (error) {
      if (error instanceof CaptureRecordError) {
        return failed("invalid_command", error.message);
      }
      throw error;
    }
    const existing = latest(session.session_id);
    if (existing !== undefined) {
      return { status: "already_applied", session: existing };
    }
    if (deps.requireCaptureBindings === true && bindingDigestsFor(session).length === 0) {
      return failed(
        "binding_missing",
        "no Capture-scope model provider binding is committed for this profile decision",
      );
    }
    appendCaptureSessionRecord(root, session);
    appendCaptureCheckpointRecord(root, createCaptureCheckpointRecord(session));
    return drive(session.session_id);
  }

  async function submitAnswers(
    command: SubmitClarificationAnswersCommand,
  ): Promise<CaptureOutcome> {
    const session = latest(command.session_id);
    if (session === undefined) {
      return failed("session_not_found", `unknown capture session: ${command.session_id}`);
    }
    const questions = readCaptureQuestions(root, command.session_id);
    const persistedAnswers = readCaptureAnswers(root, command.session_id);
    const records = [];
    for (const input of command.answers) {
      const question = questions.find((candidate) => candidate.question_id === input.question_id);
      if (question === undefined) {
        return failed(
          "unknown_question",
          `question does not exist in this session: ${input.question_id}`,
          session,
        );
      }
      let record;
      try {
        record = createClarificationAnswerRecord({
          session_id: command.session_id,
          question,
          answer_kind: input.answer_kind,
          value: input.value,
          actor: command.actor,
          expected_session_digest: command.expected_session_digest,
        });
      } catch (error) {
        if (error instanceof CaptureRecordError) {
          return failed("invalid_command", error.message, session);
        }
        throw error;
      }
      records.push(record);
    }
    const isPersisted = (answerId: string) =>
      persistedAnswers.some((candidate) => candidate.answer_id === answerId);
    const consumed =
      records.length > 0 &&
      records.every((record) => isPersisted(record.answer_id)) &&
      records.every((record) => !session.pending_question_ids.includes(record.question_id));
    if (consumed) {
      return { status: "already_applied", session };
    }
    if (isTerminalCaptureState(session.state)) {
      return failed(
        "invalid_transition",
        `cannot submit clarification answers in state ${session.state}`,
        session,
      );
    }
    if (command.expected_session_digest !== session.record_digest) {
      return {
        status: "conflict",
        session,
        expected_session_digest: command.expected_session_digest,
        actual_session_digest: session.record_digest,
      };
    }
    if (session.state !== "clarification_required") {
      return failed(
        "invalid_transition",
        `cannot submit clarification answers in state ${session.state}`,
        session,
      );
    }
    for (const record of records) {
      if (!session.pending_question_ids.includes(record.question_id)) {
        return failed(
          "unknown_question",
          `question is not pending in this session: ${record.question_id}`,
          session,
        );
      }
    }
    for (const record of records) {
      if (!isPersisted(record.answer_id)) {
        const prior = persistedAnswers.filter(
          (candidate) => candidate.question_id === record.question_id,
        );
        if (prior.length > 0) {
          return failed(
            "answer_conflict",
            `question ${record.question_id} already has a different committed answer`,
            session,
          );
        }
        appendCaptureAnswerRecord(root, record);
      }
    }
    const pendingQuestions = session.pending_question_ids
      .map((questionId) => questions.find((question) => question.question_id === questionId))
      .filter((question): question is ClarificationQuestionRecord => question !== undefined);
    const answeredIds = new Set(
      readCaptureAnswers(root, command.session_id).map((answer) => answer.question_id),
    );
    const allRequiredAnswered = pendingQuestions
      .filter((question) => question.required)
      .every((question) => answeredIds.has(question.question_id));
    if (!allRequiredAnswered) {
      return awaitingAnswersOutcome(session);
    }
    transition(session, { state: "context_compiling", pending_question_ids: [] });
    return drive(command.session_id);
  }

  async function requestRevision(command: RequestPrdRevisionCommand): Promise<CaptureOutcome> {
    const session = latest(command.session_id);
    if (session === undefined) {
      return failed("session_not_found", `unknown capture session: ${command.session_id}`);
    }
    if (isTerminalCaptureState(session.state)) {
      return failed(
        "invalid_transition",
        `cannot request a PRD revision in state ${session.state}`,
        session,
      );
    }
    if (command.expected_session_digest !== session.record_digest) {
      return {
        status: "conflict",
        session,
        expected_session_digest: command.expected_session_digest,
        actual_session_digest: session.record_digest,
      };
    }
    if (session.state !== "revision_required") {
      return failed(
        "invalid_transition",
        `cannot request a PRD revision in state ${session.state}`,
        session,
      );
    }
    transition(session, {
      state: "context_compiling",
      ...(command.updated_intent_text === undefined
        ? {}
        : { intent_text: command.updated_intent_text }),
    });
    return drive(command.session_id);
  }

  async function submitManualReviewInput(
    command: SubmitManualReviewInputCommand,
  ): Promise<CaptureOutcome> {
    const session = latest(command.session_id);
    if (session === undefined) {
      return failed("session_not_found", `unknown capture session: ${command.session_id}`);
    }
    if (isTerminalCaptureState(session.state)) {
      return failed(
        "invalid_transition",
        `cannot submit a manual review input in state ${session.state}`,
        session,
      );
    }
    if (command.expected_session_digest !== session.record_digest) {
      return {
        status: "conflict",
        session,
        expected_session_digest: command.expected_session_digest,
        actual_session_digest: session.record_digest,
      };
    }
    let record;
    try {
      record = createManualReviewInputRecord({
        session,
        review_invocation_id: command.review_invocation_id,
        reviewer_actor: command.reviewer_actor,
        rubric_digest: command.rubric_digest,
        dimension_inputs: [...command.dimension_inputs],
        expected_session_digest: command.expected_session_digest,
      });
    } catch (error) {
      if (error instanceof ReviewRecordError) {
        return failed("invalid_command", error.message, session);
      }
      throw error;
    }
    const alreadyCommitted = readManualReviewInputs(root, command.session_id).some(
      (candidate) => candidate.manual_review_input_id === record.manual_review_input_id,
    );
    if (alreadyCommitted) {
      return { status: "already_applied", session };
    }
    if (session.state !== "review_input_required") {
      return failed(
        "invalid_transition",
        `cannot submit a manual review input in state ${session.state}`,
        session,
      );
    }
    const reviewInvocations = readCaptureInvocations(root, command.session_id).filter(
      (candidate) => candidate.purpose === "review",
    );
    if (
      !reviewInvocations.some(
        (candidate) => candidate.invocation_id === command.review_invocation_id,
      )
    ) {
      return failed(
        "invalid_command",
        `review invocation ${command.review_invocation_id} is not committed for this session`,
        session,
      );
    }
    appendManualReviewInputRecord(root, record);
    transition(session, { state: "reviewing" });
    return drive(command.session_id);
  }

  async function applyApprovalDecision(
    command: ApplyApprovalDecisionCommand,
  ): Promise<CaptureOutcome> {
    const revisions = revisionsOf(command.session_id);
    const session = revisions.at(-1);
    if (session === undefined) {
      return failed("session_not_found", `unknown capture session: ${command.session_id}`);
    }
    // Decision consumption key: session + revision + request + decision +
    // object digest. A decision already consumed by any revision replays as
    // an idempotent no-op, even when the caller still holds the old digest.
    if (
      revisions.some((revision) => revision.applied_approval_decision_id === command.decision_id)
    ) {
      return { status: "already_applied", session };
    }
    if (isTerminalCaptureState(session.state)) {
      return failed(
        "invalid_transition",
        `cannot apply an approval decision in state ${session.state}`,
        session,
      );
    }
    if (command.expected_session_digest !== session.record_digest) {
      return {
        status: "conflict",
        session,
        expected_session_digest: command.expected_session_digest,
        actual_session_digest: session.record_digest,
      };
    }
    if (session.state !== "approval_required") {
      return failed(
        "invalid_transition",
        `cannot apply an approval decision in state ${session.state}`,
        session,
      );
    }
    const decision = deps.readApprovalDecision?.(command.request_id, command.decision_id);
    if (decision === undefined) {
      return failed(
        "approval_decision_not_found",
        `no committed approval decision ${command.decision_id} for request ${command.request_id}`,
        session,
      );
    }
    if (
      command.request_id !== session.current_approval_request_id ||
      decision.request_id !== session.current_approval_request_id
    ) {
      return failed(
        "approval_request_mismatch",
        "the decision does not resolve the session's current approval request",
        session,
      );
    }
    if (session.current_proposal_digest === undefined) {
      return failed("missing_approval_object", "no current proposal digest to approve", session);
    }
    if (decision.object_digest !== session.current_proposal_digest) {
      return failed(
        "approval_binding_mismatch",
        "the decision is bound to a different object digest than the current proposal",
        session,
      );
    }
    const drift = checkBindingDrift(session);
    if (drift !== undefined) return drift;
    if (decision.decision === "reject" && (decision.reason ?? "").trim().length === 0) {
      return failed("reject_reason_required", "a reject decision must carry a reason", session);
    }
    deps.failpoint?.("decision.consumed");
    if (decision.decision === "approve") {
      // T7 atomic accepted transaction: when the accept stage is wired it
      // commits the AcceptedPrdRecord, the RequirementBaseline, the graph
      // records and the bindings in one ledger commit before the session may
      // enter `accepted`. Kernel-only configurations (no accept handler) keep
      // the bare state transition.
      if (handlers.accept !== undefined) {
        const acceptFailure = await runAcceptance(session, {
          request_id: command.request_id,
          decision_id: command.decision_id,
          actor: decision.actor,
          ...(decision.decision_digest === undefined
            ? {}
            : { decision_digest: decision.decision_digest }),
        });
        if (acceptFailure !== undefined) return acceptFailure;
      }
      transition(session, {
        state: "accepted",
        applied_approval_decision_id: command.decision_id,
      });
    } else if (decision.decision === "reject") {
      transition(session, {
        state: "revision_required",
        applied_approval_decision_id: command.decision_id,
      });
    } else {
      transition(session, {
        state: "approval_deferred",
        applied_approval_decision_id: command.decision_id,
      });
    }
    return drive(command.session_id);
  }

  async function resume(command: ResumeCaptureCommand): Promise<CaptureOutcome> {
    const session = latest(command.session_id);
    if (session === undefined) {
      return failed("session_not_found", `unknown capture session: ${command.session_id}`);
    }
    if (session.state === "blocked") {
      const blocker = readCaptureBlockers(root, command.session_id)
        .filter((candidate) => candidate.session_revision <= session.revision)
        .sort((left, right) => right.session_revision - left.session_revision)
        .at(0);
      if (blocker === undefined) {
        return failed(
          "invalid_transition",
          "blocked session without a committed blocker record",
          session,
        );
      }
      const cleared =
        blocker.reason === "review_provider_required" || blocker.reason === "review_blocked"
          ? handlers.review !== undefined
          : blocker.reason === "approval_brief_provider_required"
            ? handlers.approvalBrief !== undefined
            : blocker.reason === "capture_budget_exhausted"
              ? session.round + 1 <= maxRounds
              : false; // risk_policy_denied: only a policy change can clear it
      if (!cleared) {
        return { status: "blocked", session, blocker };
      }
      transition(session, { state: blocker.resume_state });
      return drive(command.session_id);
    }
    if (session.state === "approval_deferred") {
      // Re-sign the approval request on a fresh revision only when the
      // bindings that produced the proposal round are still intact.
      const drift = checkBindingDrift(session);
      if (drift !== undefined) return drift;
      if (session.current_proposal_digest === undefined) {
        return failed("missing_approval_object", "deferred approval lost its object", session);
      }
      const requestId = deriveApprovalRequestId(session, session.revision + 1);
      transition(session, {
        state: "approval_required",
        current_approval_request_id: requestId,
      });
      return drive(command.session_id);
    }
    return drive(command.session_id);
  }

  async function cancel(command: CancelCaptureCommand): Promise<CaptureOutcome> {
    const session = latest(command.session_id);
    if (session === undefined) {
      return failed("session_not_found", `unknown capture session: ${command.session_id}`);
    }
    if (session.state === "cancelled") {
      return { status: "already_applied", session };
    }
    if (isTerminalCaptureState(session.state)) {
      return failed(
        "invalid_transition",
        `cannot cancel a session in state ${session.state}`,
        session,
      );
    }
    transition(session, { state: "cancelled" });
    return { status: "cancelled", session: latest(command.session_id) ?? session };
  }

  return {
    advance(command: CaptureCommand): Promise<CaptureOutcome> {
      switch (command.command) {
        case "start_capture":
          return start(command);
        case "submit_clarification_answers":
          return submitAnswers(command);
        case "submit_manual_review_input":
          return submitManualReviewInput(command);
        case "request_prd_revision":
          return requestRevision(command);
        case "apply_approval_decision":
          return applyApprovalDecision(command);
        case "resume_capture":
          return resume(command);
        case "cancel_capture":
          return cancel(command);
      }
    },
    current(sessionId: string): CaptureSessionRecord | undefined {
      return latest(sessionId);
    },
  };
}
