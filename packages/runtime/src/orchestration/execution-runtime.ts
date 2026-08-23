import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  canonicalizeJson,
  contentDigest,
  verifyRecordEnvelope,
  type TaskTddContract,
} from "@universal-harness-internal/core";
import type { AgentRunResult } from "@universal-harness-internal/plugin-sdk";

import type { TaskSpecification } from "../planning/task.js";
import type { StrictTddExecutionPort, StrictTddTaskOutcome } from "../tdd/execution-runner.js";
import type { AbortReason, RecoverableBlockReason } from "../workflow/state-machine.js";
import type { OrchestrationPhase } from "./phases.js";
import { OrchestrationError, type OrchestratorDependencies } from "./pipeline-types.js";
import type { ExecutionBinding } from "./execution-binding.js";

export interface StrictTddArtifact {
  readonly path: string;
  readonly content: string;
}

export interface RequiredTddExecution {
  readonly outcome: StrictTddTaskOutcome;
  readonly result: AgentRunResult;
  readonly artifacts: readonly StrictTddArtifact[];
}

function assertStrictTddOutcomeBinding(
  task: TaskSpecification,
  contract: TaskTddContract,
  outcome: StrictTddTaskOutcome,
): void {
  if (outcome.task_id !== task.id || outcome.cycle.task_id !== task.id) {
    throw new OrchestrationError("binding_drift", "StrictTddExecutionPort returned another Task");
  }
  if (
    outcome.cycle.contract_digest !== contract.contract_digest ||
    outcome.cycle.logical_cycle_id !== contract.assertion_clusters[0]?.logical_cycle_id
  ) {
    throw new OrchestrationError(
      "binding_drift",
      "StrictTddExecutionPort returned evidence for another contract or logical cycle",
    );
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("tdd-cycle", outcome.cycle);
  if (!validation.valid || !verifyRecordEnvelope(outcome.cycle)) {
    throw new OrchestrationError(
      "binding_drift",
      `StrictTddExecutionPort returned an invalid cycle: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  if (outcome.status === "completed" && outcome.cycle.status !== "completed") {
    throw new OrchestrationError(
      "binding_drift",
      "StrictTddExecutionPort claimed completion without a completed cycle",
    );
  }
  if (
    outcome.status === "completed" &&
    outcome.implementation_revision !== outcome.cycle.implementation_revision
  ) {
    throw new OrchestrationError(
      "binding_drift",
      "StrictTddExecutionPort implementation revision does not match its completed cycle",
    );
  }
  if (outcome.status === "blocked" && outcome.cycle.status === "completed") {
    throw new OrchestrationError(
      "binding_drift",
      "StrictTddExecutionPort returned a blocked outcome with a completed cycle",
    );
  }
  const evidenceDigests = new Set(outcome.evidence.map((evidence) => contentDigest(evidence)));
  const requiredEvidence = [
    outcome.cycle.baseline_evidence_digest,
    outcome.cycle.red_evidence_digest,
    outcome.cycle.green_evidence_digest,
    outcome.cycle.refactor_evidence_digest,
  ].filter((digest): digest is string => digest !== undefined);
  if (requiredEvidence.some((digest) => !evidenceDigests.has(digest))) {
    throw new OrchestrationError(
      "binding_drift",
      "StrictTddExecutionPort omitted evidence referenced by its cycle",
    );
  }
  for (const evidence of outcome.evidence) {
    if (
      evidence.task_id !== task.id ||
      evidence.contract_digest !== contract.contract_digest ||
      evidence.logical_cycle_id !== outcome.cycle.logical_cycle_id ||
      evidence.attempt_ordinal !== outcome.cycle.attempt_ordinal
    ) {
      throw new OrchestrationError(
        "binding_drift",
        "StrictTddExecutionPort returned an evidence binding outside the current attempt",
      );
    }
  }
}

/**
 * Invoke the required-task controller once and translate only accepted,
 * digest-bound TDD facts into the ordinary Run surface. Agent narration is
 * never accepted as proof; the cycle/evidence returned by the controller is
 * revalidated here before the coordinator can persist it.
 */
export async function executeRequiredTddTask(input: {
  readonly port: StrictTddExecutionPort;
  readonly task: TaskSpecification;
  readonly contract: TaskTddContract;
  readonly capabilityPlanDigest: string;
}): Promise<RequiredTddExecution> {
  if (input.contract.contract_mode !== "required") {
    throw new OrchestrationError(
      "binding_drift",
      "executeRequiredTddTask accepts only required contracts",
    );
  }
  if (input.contract.capability_plan_digest !== input.capabilityPlanDigest) {
    throw new OrchestrationError("binding_drift", "TaskTddContract CapabilityPlan binding drift");
  }
  const startedAt = Date.now();
  const outcome = await input.port.runTask({
    task: input.task,
    contract: input.contract,
    capability_plan_digest: input.capabilityPlanDigest,
  });
  assertStrictTddOutcomeBinding(input.task, input.contract, outcome);

  const evidenceArtifacts = outcome.evidence.map((evidence) => {
    const digest = contentDigest(evidence);
    return {
      path: `artifacts/tdd-evidence/${outcome.cycle.logical_cycle_id}-${String(outcome.cycle.attempt_ordinal)}-${evidence.evidence_type}-${digest.slice(0, 12)}.json`,
      content: `${canonicalizeJson(evidence)}\n`,
    };
  });
  const grantArtifacts = outcome.grants.map((grant) => ({
    path: `artifacts/tdd-grants/${grant.digest}.json`,
    content: `${canonicalizeJson(grant)}\n`,
  }));
  const cyclePath = `artifacts/tdd-cycles/${outcome.cycle.logical_cycle_id}-${String(outcome.cycle.attempt_ordinal)}.json`;
  const result: AgentRunResult = {
    outcome: outcome.status === "completed" ? "handoff" : "failed",
    termination_reason: outcome.status === "completed" ? "completion" : "adapter_failure",
    completion_claimed: outcome.status === "completed",
    summary:
      outcome.status === "completed"
        ? `strict TDD proven for ${input.task.id}`
        : `strict TDD blocked for ${input.task.id}: ${outcome.reason}`,
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      duration_ms: Date.now() - startedAt,
      metering: "unmetered",
    },
    evidence: [
      {
        kind: "tdd_cycle",
        locator: `ledger://${cyclePath}`,
        digest: outcome.cycle.record_digest,
      },
      ...outcome.evidence.map((evidence) => {
        const digest = contentDigest(evidence);
        return {
          kind: evidence.evidence_type,
          locator: `ledger://artifacts/tdd-evidence/${outcome.cycle.logical_cycle_id}-${String(outcome.cycle.attempt_ordinal)}-${evidence.evidence_type}-${digest.slice(0, 12)}.json`,
          digest,
        };
      }),
    ],
    undeclared_writes: [],
  };
  return {
    outcome,
    result,
    artifacts: [
      { path: cyclePath, content: `${canonicalizeJson(outcome.cycle)}\n` },
      ...evidenceArtifacts,
      ...grantArtifacts,
    ],
  };
}

/** Resolve the only execution authority; implementation work never defaults. */
export function resolveExecutionBinding(deps: OrchestratorDependencies): ExecutionBinding {
  if (deps.execution !== undefined) return deps.execution;
  if (deps.execute !== undefined) {
    return {
      kind: "agent",
      name: "legacy-unproven-agent",
      deterministic: false,
      execute: deps.execute,
    };
  }
  throw new OrchestrationError(
    "configuration",
    "executor_required: implementation work requires an explicit agent or deterministic workflow execution binding",
  );
}

/** Deterministic Kahn ordering over accepted Task dependencies. */
export function orderExecutionTasks(
  tasks: readonly TaskSpecification[],
): readonly TaskSpecification[] {
  const byTaskId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>(tasks.map((task) => [task.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byTaskId.has(dependency)) continue;
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.id]);
    }
  }
  const ready = tasks
    .map((task) => task.id)
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort();
  const ordered: TaskSpecification[] = [];
  while (ready.length > 0) {
    const next = ready.shift() as string;
    ordered.push(byTaskId.get(next) as TaskSpecification);
    for (const dependent of (dependents.get(next) ?? []).sort()) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        const insertAt = ready.findIndex((id) => id > dependent);
        ready.splice(insertAt === -1 ? ready.length : insertAt, 0, dependent);
      }
    }
  }
  return ordered;
}

export type RunFailureDisposition =
  | { readonly reason: RecoverableBlockReason; readonly resumePhase: OrchestrationPhase }
  | { readonly abort: AbortReason };

/** One authoritative adapter-failure -> workflow recovery policy. */
export function classifyRunFailure(result: AgentRunResult): RunFailureDisposition {
  switch (result.outcome) {
    case "correct_block":
      return { abort: "policy_violation" };
    case "partial":
      return { reason: "budget_ceiling", resumePhase: "execute" };
    case "clarification_required":
      return { reason: "missing_input", resumePhase: "capture" };
    case "handoff":
      return { reason: "missing_input", resumePhase: "execute" };
    default:
      return { reason: "transient_environment_failure", resumePhase: "execute" };
  }
}
