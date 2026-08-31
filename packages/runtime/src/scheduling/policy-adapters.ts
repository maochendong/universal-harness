import {
  SCHEDULER_POLICY_ACTION_KINDS,
  PolicyError,
  actionDigest,
  normalizeAction,
} from "../policy/action.js";
import type { CapabilityGrant } from "../policy/capability-grant.js";
import { buildDecision, type PolicyDecision, type PolicyLayerInput } from "../policy/decision.js";
import { decideAction, mergePolicyLayers } from "../policy/evaluator.js";
import {
  SchedulingPortError,
  type PolicyDecisionPort,
  type SchedulerPolicyAction,
  type SchedulerPolicyInput,
} from "./ports.js";

/**
 * PolicyDecisionPort Adapters (design §5.2/§11, plan Task 4 step 4). The
 * production Adapter normalizes SchedulerPolicyInput into a control-plane
 * PolicyAction and delegates to the deterministic evaluator; the InMemory
 * Adapter accepts a deterministic resolver for conformance and fault
 * injection but still validates that the returned decision binds the exact
 * request (action digest) and the exact effective policy the request pinned.
 * Neither Adapter writes Approval, Lease, Finding or Ledger state.
 */

function sorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * Normalize a SchedulerPolicyInput into the canonical control-plane
 * PolicyAction (design §5.2): actor `harness`, origin `control_plane`, phase
 * `execute`, and every binding carried in canonical parameters with sorted
 * arrays and explicit nulls for absent optionals, so logically equal inputs
 * always digest identically. Structurally incomplete requests — a dispatch or
 * retry without a Task digest, an integration without a wave index, a retry
 * without a retry kind — fail closed as invalid_action before any decision.
 */
export function schedulerPolicyAction(input: SchedulerPolicyInput): SchedulerPolicyAction {
  if (!(SCHEDULER_POLICY_ACTION_KINDS as readonly string[]).includes(input.action)) {
    throw new PolicyError(
      "invalid_action",
      `scheduler action must be one of ${SCHEDULER_POLICY_ACTION_KINDS.join(", ")}`,
    );
  }
  if (
    (input.action === "dispatch_task" || input.action === "retry_task") &&
    input.task_digest === undefined
  ) {
    throw new PolicyError(
      "invalid_action",
      `${input.action} requires the task_digest binding of the exact Task it acts on`,
    );
  }
  if (input.action === "integrate_wave" && input.wave_index === undefined) {
    throw new PolicyError(
      "invalid_action",
      "integrate_wave requires the wave_index binding of the exact wave it integrates",
    );
  }
  if (input.action === "retry_task" && input.retry_kind === undefined) {
    throw new PolicyError(
      "invalid_action",
      "retry_task requires the retry_kind binding (executor_retry or integration_retry)",
    );
  }
  const action = normalizeAction({
    kind: input.action,
    actor: "harness",
    actor_kind: "harness",
    origin: "control_plane",
    phase: "execute",
    parameters: {
      operation_id: input.operation_id,
      iteration_id: input.iteration_id,
      plan_digest: input.plan_digest,
      task_digest: input.task_digest ?? null,
      wave_index: input.wave_index ?? null,
      baseline_commit: input.baseline_commit,
      capabilities: sorted(input.capabilities),
      tools: sorted(input.tools),
      write_paths: sorted(input.write_paths),
      exclusive_resources: sorted(input.exclusive_resources),
      task_remaining_budget: input.task_remaining_budget ?? null,
      iteration_remaining_budget: input.iteration_remaining_budget,
      adapter_manifest_digest: input.adapter_manifest_digest,
      retry_kind: input.retry_kind ?? null,
    },
    risk: input.risk,
    ...(input.approval_digest === undefined ? {} : { approval_digest: input.approval_digest }),
    control_profile: input.adapter_control_profile,
  });
  return action as SchedulerPolicyAction;
}

/**
 * Production Adapter over the deterministic policy evaluator. The grant
 * reader is keyed by the Task identity the scheduler holds at decision time —
 * SchedulerPolicyInput carries the Task semantic digest, so that digest is
 * what `readGrant` receives (undefined for wave-level actions).
 */
export function createPolicyDecisionAdapter(options: {
  readonly readLayers: () => readonly PolicyLayerInput[];
  readonly readGrant: (taskId: string | undefined) => CapabilityGrant | undefined;
}): PolicyDecisionPort {
  return {
    name: "workflow-policy-decision",
    async decide(input) {
      const action = schedulerPolicyAction(input);
      const layers = options.readLayers();
      const merged = mergePolicyLayers(layers);
      if (input.effective_policy_digest !== merged.effective.digest) {
        // A request formed under a stale effective policy never decides — not
        // even with an approval, since the approval bound the drifted policy.
        return buildDecision({
          outcome: "block",
          reasons: [
            `blocked: the request binds effective policy ${input.effective_policy_digest} but ` +
              `the current layers merge to ${merged.effective.digest}; a stale policy binding ` +
              "never decides and no approval covers the drift",
          ],
          action_digest: actionDigest(action),
          effective: merged.effective,
        });
      }
      return decideAction(layers, action, options.readGrant(input.task_digest));
    },
  };
}

/** Deterministic decision resolver the InMemory Adapter delegates to. */
export type SchedulerPolicyResolver = (
  action: SchedulerPolicyAction,
  input: SchedulerPolicyInput,
) => PolicyDecision;

/**
 * Conformance/fault-injection Adapter. The resolver is free to inject any
 * outcome, but the returned decision must still bind the exact normalized
 * request (action_digest) and the exact effective policy the request pinned
 * (effective_policy_digest); a resolver answering a different question fails
 * closed with a typed error instead of leaking a forged decision.
 */
export function createInMemoryPolicyDecisionPort(options: {
  readonly resolve: SchedulerPolicyResolver;
}): PolicyDecisionPort {
  return {
    name: "in-memory-policy-decision",
    async decide(input) {
      const action = schedulerPolicyAction(input);
      const decision = options.resolve(action, input);
      const expectedActionDigest = actionDigest(action);
      if (decision.action_digest !== expectedActionDigest) {
        throw new SchedulingPortError(
          "invalid_decision",
          `resolver decision binds action digest ${decision.action_digest} but the request ` +
            `normalizes to ${expectedActionDigest}`,
        );
      }
      if (decision.effective_policy_digest !== input.effective_policy_digest) {
        throw new SchedulingPortError(
          "invalid_decision",
          `resolver decision binds effective policy digest ${decision.effective_policy_digest} ` +
            `but the request pinned digest ${input.effective_policy_digest}`,
        );
      }
      return decision;
    },
  };
}
