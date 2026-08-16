import { contentDigest } from "@universal-harness-internal/core";

import { narrowGrant, type CapabilityGrant } from "../policy/capability-grant.js";
import { ToolError } from "../tools/definition.js";
import type { ToolInvocationEvidence } from "../tools/invocation.js";
import {
  applyWorkingStateProposal,
  WorkingStateError,
  type WorkingState,
  type WorkingStateProposal,
} from "../workflow/working-state.js";
import {
  adapterFailureDecision,
  budgetCeilingDecision,
  cancellationDecision,
  LoopPhaseMachine,
  repeatDetectionDecision,
  timeoutDecision,
  type PartialOutput,
  type TerminalDecision,
} from "./outcome.js";
import { LoopError } from "./policy.js";
import { actionFingerprint, RepeatDetector } from "./repeat-detector.js";
import type { TaskEnvelope } from "./task-envelope.js";

/**
 * Managed Loop Controller (design 13.3). The controller owns the loop: the
 * model (behind the `step` port) only ever sees a frozen read view and may
 * return tool calls plus a typed WorkingStateProposal. Budgets are metered
 * by the Harness (fake clock and usage meter in tests), the capability grant
 * is narrowed after every executed step, repeat detection is always on, and
 * a completion signal can only move the run into `verifying` -- the terminal
 * `success` requires current mandatory evidence. Every exit produces exactly
 * one TerminalDecision; persisting it as the single RunTerminated record is
 * the WorkflowEngine's job, and a process interruption leaves no terminal
 * record so resume appends the RunInterrupted (design 10.2).
 */
export interface LoopToolCall {
  readonly tool: string;
  readonly parameters: Record<string, unknown>;
  readonly resource?: string;
}

export interface LoopStepRemaining {
  readonly steps: number;
  readonly tokens: number;
  readonly duration_ms: number;
}

/** Frozen read view handed to the model turn; mutation is a TypeError. */
export interface LoopStepInput {
  readonly step: number;
  readonly envelope: TaskEnvelope;
  readonly state: WorkingState;
  readonly grant: CapabilityGrant;
  readonly remaining: LoopStepRemaining;
}

export type ModelStepOutcome =
  | {
      readonly kind: "work";
      readonly tool_calls?: readonly LoopToolCall[];
      readonly proposal?: WorkingStateProposal;
      readonly partial_output?: PartialOutput;
    }
  | { readonly kind: "complete"; readonly proposal?: WorkingStateProposal };

export type ModelStep = (input: LoopStepInput) => ModelStepOutcome | Promise<ModelStepOutcome>;

export interface UsageMeter {
  /** Total tokens consumed by the run so far. */
  usedTokens(): number;
}

export interface LoopProgressEvent {
  readonly step: number;
  readonly kind:
    | "step_started"
    | "tool_call"
    | "tool_retried"
    | "proposal_applied"
    | "grant_narrowed"
    | "completion_signaled"
    | "terminated";
  readonly detail?: string;
  readonly fingerprint?: string;
}

export interface ManagedLoopDependencies {
  /** Millisecond clock; fake in tests. */
  readonly clock: () => number;
  /** Harness-side token meter; the model never reports its own usage. */
  readonly usage: UsageMeter;
  readonly step: ModelStep;
  /** Tool dispatch port; receives the current (narrowed) grant. */
  readonly invokeTool: (
    call: LoopToolCall,
    grant: CapabilityGrant,
  ) => Promise<ToolInvocationEvidence>;
  /** Mandatory-evidence check run in the verifying phase. */
  readonly verify: () => boolean | Promise<boolean>;
  readonly isCancelled?: () => boolean;
  readonly initialState: WorkingState;
  readonly initialGrant: CapabilityGrant;
  readonly onProgress?: (event: LoopProgressEvent) => void;
}

export interface ManagedLoopResult {
  readonly decision: TerminalDecision;
  readonly steps_executed: number;
  readonly tokens_used: number;
  readonly duration_ms: number;
  readonly final_state: WorkingState;
  readonly final_grant: CapabilityGrant;
  readonly evidence: readonly ToolInvocationEvidence[];
  readonly partial_outputs: readonly PartialOutput[];
  readonly events: readonly LoopProgressEvent[];
}

/** Keys a model proposal may carry; `budget_use` is Harness-metered only. */
const MODEL_PROPOSAL_KEYS = new Set([
  "phase",
  "task_id",
  "add_confirmed_facts",
  "add_rejected_hypotheses",
  "add_open_questions",
  "add_blockers",
  "clear_blockers",
  "reconcile_blockers",
  "set_next_action",
  "complete_task_ids",
  "add_pending_task_ids",
  "add_capability_grants",
  "add_approval_digests",
  "set_context_bundle_digest",
  "add_input_digests",
  "upsert_external_action_intents",
]);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Apply a typed model proposal. Only known WorkingStateProposal keys pass;
 * `budget_use` is rejected because usage is metered by the Harness, never
 * self-reported. This is the only channel through which a model may
 * influence WorkingState -- it can never commit state directly.
 */
function applyModelProposal(
  state: WorkingState,
  proposal: WorkingStateProposal | undefined,
): WorkingState {
  if (proposal === undefined) return state;
  for (const key of Object.keys(proposal)) {
    if (!MODEL_PROPOSAL_KEYS.has(key)) {
      throw new LoopError(
        "invalid_step_result",
        `model proposal carries unknown key "${key}"; only typed WorkingStateProposal fields pass`,
      );
    }
  }
  if (proposal.budget_use !== undefined) {
    throw new LoopError(
      "invalid_step_result",
      "model proposals may not carry budget_use; usage is metered by the Harness",
    );
  }
  return applyWorkingStateProposal(state, proposal);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Progress digest of the semantic state. Budget bookkeeping is Harness-side
 * accounting, not model progress, so it is excluded; otherwise every
 * metered step would look like progress and repeat detection could never
 * trip.
 */
function progressStateDigest(state: WorkingState): string {
  const semantic: Record<string, unknown> = { ...state };
  delete semantic["budget"];
  return contentDigest(semantic);
}

export async function runManagedLoop(
  envelope: TaskEnvelope,
  deps: ManagedLoopDependencies,
): Promise<ManagedLoopResult> {
  const policy = envelope.loop_policy;
  const machine = new LoopPhaseMachine();
  const detector = new RepeatDetector(policy.repeat_detection);
  const frozenEnvelope = deepFreeze(envelope);
  let state = deps.initialState;
  let grant = deps.initialGrant;
  let usedSteps = 0;
  const startMs = deps.clock();
  const tokensAtStart = deps.usage.usedTokens();
  let tokensBeforeStep: number;
  const evidence: ToolInvocationEvidence[] = [];
  // Progress means new distinct evidence: identical outputs leave the set --
  // and therefore its digest -- unchanged, which is what repeat detection
  // treats as stagnation.
  const evidenceDigestSet = new Set<string>();
  const partialOutputs: PartialOutput[] = [];
  const events: LoopProgressEvent[] = [];
  const emit = (event: LoopProgressEvent): void => {
    events.push(event);
    deps.onProgress?.(event);
  };

  const result = (decision: TerminalDecision): ManagedLoopResult => ({
    decision,
    steps_executed: usedSteps,
    tokens_used: deps.usage.usedTokens() - tokensAtStart,
    duration_ms: deps.clock() - startMs,
    final_state: state,
    final_grant: grant,
    evidence,
    partial_outputs: partialOutputs,
    events,
  });

  const finish = (decision: TerminalDecision): ManagedLoopResult => {
    machine.terminate(decision);
    emit({ step: usedSteps, kind: "terminated", detail: decision.termination_reason });
    return result(decision);
  };

  /** Invoke one tool call under the retry ceiling; never retries blindly. */
  const invokeWithRetry = async (call: LoopToolCall): Promise<ToolInvocationEvidence> => {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const output = await deps.invokeTool(call, grant);
        emit({ step: usedSteps, kind: "tool_call", detail: call.tool });
        return output;
      } catch (error) {
        const retryable =
          error instanceof ToolError && (error.kind === "timeout" || error.kind === "tool_failed");
        if (retryable && attempts <= policy.max_tool_retries) {
          emit({
            step: usedSteps,
            kind: "tool_retried",
            detail: `${call.tool} attempt ${String(attempts)} failed`,
          });
          continue;
        }
        throw error;
      }
    }
  };

  /** Map a terminal tool failure to a terminal decision. */
  const toolFailureDecision = (error: unknown): TerminalDecision => {
    if (error instanceof ToolError) {
      if (error.kind === "timeout") return timeoutDecision();
      if (error.kind === "tool_failed") {
        return adapterFailureDecision(`tool call failed: ${error.message}`);
      }
      if (error.kind === "uncertain_result") {
        return {
          outcome: "partial",
          termination_reason: "adapter_failure",
          detail: `external action left uncertain and must be reconciled before retry: ${error.message}`,
        };
      }
      return {
        outcome: "correct_block",
        termination_reason: "policy_denial",
        detail: error.message,
      };
    }
    return adapterFailureDecision(errorMessage(error));
  };

  const hard = policy.termination.budget_ceiling === "hard";

  try {
    for (;;) {
      if (deps.isCancelled?.() === true) return finish(cancellationDecision());
      if (hard) {
        if (usedSteps >= policy.max_steps) return finish(budgetCeilingDecision("steps"));
        if (deps.usage.usedTokens() - tokensAtStart >= policy.max_tokens) {
          return finish(budgetCeilingDecision("tokens"));
        }
        if (deps.clock() - startMs >= policy.max_duration_ms) return finish(timeoutDecision());
      }

      usedSteps += 1;
      tokensBeforeStep = deps.usage.usedTokens();
      emit({ step: usedSteps, kind: "step_started" });
      const remaining: LoopStepRemaining = {
        steps: Math.max(0, policy.max_steps - usedSteps),
        tokens: Math.max(0, policy.max_tokens - (tokensBeforeStep - tokensAtStart)),
        duration_ms: Math.max(0, policy.max_duration_ms - (deps.clock() - startMs)),
      };

      let outcome: ModelStepOutcome;
      try {
        outcome = await deps.step({
          step: usedSteps,
          envelope: frozenEnvelope,
          state: deepFreeze(state),
          grant: deepFreeze(grant),
          remaining,
        });
      } catch (error) {
        return finish(adapterFailureDecision(`model step failed: ${errorMessage(error)}`));
      }

      if (outcome.kind === "complete") {
        try {
          state = applyModelProposal(state, outcome.proposal);
        } catch (error) {
          return finish(adapterFailureDecision(errorMessage(error)));
        }
        emit({ step: usedSteps, kind: "completion_signaled" });
        machine.signalCompletion();
        const verified = policy.termination.require_external_verification
          ? await deps.verify()
          : true;
        const decision = machine.verify(verified);
        emit({ step: usedSteps, kind: "terminated", detail: decision.termination_reason });
        return result(decision);
      }

      try {
        for (const call of outcome.tool_calls ?? []) {
          const output = await invokeWithRetry(call);
          evidence.push(output);
          evidenceDigestSet.add(output.output_digest);
          const observation = detector.observe({
            fingerprint: actionFingerprint({
              tool: call.tool,
              parameters: call.parameters,
              ...(call.resource === undefined ? {} : { resource: call.resource }),
            }),
            state_digest: progressStateDigest(state),
            evidence_digest: contentDigest([...evidenceDigestSet].sort()),
          });
          if (observation.repeated) {
            return finish(repeatDetectionDecision(observation.fingerprint ?? ""));
          }
        }
        state = applyModelProposal(state, outcome.proposal);
        if (outcome.partial_output !== undefined) partialOutputs.push(outcome.partial_output);
        emit({ step: usedSteps, kind: "proposal_applied" });
        // Harness-metered budget accounting; the model never reports usage.
        state = applyWorkingStateProposal(state, {
          budget_use: {
            used_steps: 1,
            used_tokens: deps.usage.usedTokens() - tokensBeforeStep,
          },
        });
      } catch (error) {
        if (error instanceof WorkingStateError && error.kind === "budget_ceiling") {
          return finish({
            outcome: "partial",
            termination_reason: "budget_ceiling",
            detail: error.message,
          });
        }
        if (error instanceof LoopError && error.kind === "invalid_step_result") {
          return finish(adapterFailureDecision(error.message));
        }
        return finish(toolFailureDecision(error));
      }

      // Dynamic narrowing: every executed step shrinks the grant's remaining
      // budget; no step can ever grow it back.
      const narrowed = narrowGrant(grant, {
        budget: {
          steps: Math.min(grant.budget.steps, Math.max(0, policy.max_steps - usedSteps)),
          tokens: Math.min(
            grant.budget.tokens,
            Math.max(0, policy.max_tokens - (deps.usage.usedTokens() - tokensAtStart)),
          ),
        },
      });
      if (narrowed.digest !== grant.digest) {
        grant = narrowed;
        emit({ step: usedSteps, kind: "grant_narrowed", detail: grant.digest });
      }

      if (!hard) {
        if (usedSteps >= policy.max_steps) return finish(budgetCeilingDecision("steps"));
        if (deps.usage.usedTokens() - tokensAtStart >= policy.max_tokens) {
          return finish(budgetCeilingDecision("tokens"));
        }
        if (deps.clock() - startMs >= policy.max_duration_ms) return finish(timeoutDecision());
      }
    }
  } catch (error) {
    // Last-resort exit: still exactly one terminal decision.
    if (machine.phase === "terminated") throw error;
    return finish(adapterFailureDecision(`loop aborted: ${errorMessage(error)}`));
  }
}
