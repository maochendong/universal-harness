import {
  contentDigest,
  type CapabilityId,
  type TaskTddContract,
} from "@universal-harness-internal/core";

import type { TaskSpecification } from "../planning/task.js";
import type {
  FeedbackAnalysisCoordinator,
  FeedbackAnalysisRequest,
} from "../finding/feedback-analysis-coordinator.js";
import type { StrictTddExecutionPort, StrictTddTaskOutcome } from "../tdd/execution-runner.js";
import type { DagNodeContext, DagNodeRunner, DagRunnerRegistry } from "../workflow/dag.js";

export const CAPABILITY_DAG_KERNEL_NODE_IDS = [
  "capture",
  "capability_decision",
  "plan",
  "context",
  "execute",
  "verify",
  "snapshot",
] as const;

export interface CapabilityDagRunnerPorts {
  readonly kernel: Readonly<Record<string, DagNodeRunner>>;
  readonly modules?: Readonly<Partial<Record<CapabilityId, DagNodeRunner>>>;
  readonly feedbackAnalysis?: {
    readonly coordinator: FeedbackAnalysisCoordinator;
    readonly requests: (
      context: DagNodeContext,
      result: Awaited<ReturnType<DagNodeRunner>>,
    ) => readonly FeedbackAnalysisRequest[];
  };
}

export type { FeedbackAnalysisRequest } from "../finding/feedback-analysis-coordinator.js";

function withFeedbackAnalysis(
  runner: DagNodeRunner,
  feedback: NonNullable<CapabilityDagRunnerPorts["feedbackAnalysis"]>,
): DagNodeRunner {
  return async (context) => {
    const result = await runner(context);
    if (result.status !== "committed") return result;
    for (const request of feedback.requests(context, result)) {
      const outcome = await feedback.coordinator.analyzeFinding(request);
      if (outcome.status === "blocked") {
        return {
          status: "blocked",
          reason: "feedback_analysis_required",
          detail: outcome.failure.summary,
        };
      }
      if (outcome.status === "analyzed" && outcome.disposition === "requires_human_review") {
        return {
          status: "blocked",
          reason: "feedback_analysis_review_required",
          detail: `feedback analysis ${outcome.record.analysis_id} requires human review before routing`,
        };
      }
    }
    return result;
  };
}

/**
 * Production runner assembly seam. The registry contains phase ports only;
 * profile selection and DAG topology remain exclusively in CapabilityPlan.
 */
export function createCapabilityDagRunnerRegistry(
  ports: CapabilityDagRunnerPorts,
): DagRunnerRegistry {
  const kernel = { ...ports.kernel };
  const modules = { ...ports.modules };
  if (ports.feedbackAnalysis !== undefined) {
    const verify = kernel["verify"];
    if (verify !== undefined) {
      kernel["verify"] = withFeedbackAnalysis(verify, ports.feedbackAnalysis);
    }
    for (const capabilityId of ["independent_evaluation", "advanced_audit"] as const) {
      const runner = modules[capabilityId];
      if (runner !== undefined) {
        modules[capabilityId] = withFeedbackAnalysis(runner, ports.feedbackAnalysis);
      }
    }
  }
  return Object.freeze({
    kernel: Object.freeze(kernel),
    ...(ports.modules === undefined ? {} : { modules: Object.freeze(modules) }),
  });
}

export type TddTaskRouteOutcome =
  | StrictTddTaskOutcome
  | {
      readonly task_id: string;
      readonly tdd_verdict: "controlled_not_applicable" | "not_enabled_by_profile";
    };

export interface StrictTddExecuteDagRunnerPorts {
  readonly tasks: (context: DagNodeContext) => readonly TaskSpecification[];
  readonly contract: (
    task: TaskSpecification,
    context: DagNodeContext,
  ) => TaskTddContract | undefined;
  readonly strictTdd: StrictTddExecutionPort;
  /** Explicit non-TDD execution; there is no implicit direct executor. */
  readonly executeNormally: (task: TaskSpecification, context: DagNodeContext) => Promise<void>;
  readonly acceptedDesignBinding: (contract: TaskTddContract, context: DagNodeContext) => boolean;
  readonly onTaskOutcome?: (outcome: TddTaskRouteOutcome) => void | Promise<void>;
}

/**
 * Execute-node adapter for the strict_tdd subgraph declared by CapabilityPlan.
 * Profile names never participate: the node's accepted `subgraph` marker is
 * the sole activation authority.
 */
export function createStrictTddExecuteDagRunner(
  ports: StrictTddExecuteDagRunnerPorts,
): DagNodeRunner {
  return async (context) => {
    const strict = context.node.subgraph === "strict_tdd";
    const outcomes: TddTaskRouteOutcome[] = [];
    for (const task of ports.tasks(context)) {
      if (!strict) {
        await ports.executeNormally(task, context);
        outcomes.push({ task_id: task.id, tdd_verdict: "not_enabled_by_profile" });
        continue;
      }
      const contract = ports.contract(task, context);
      if (contract === undefined) {
        return {
          status: "blocked",
          reason: "tdd_contract_required",
          detail: `strict_tdd task ${task.id} has no TaskTddContract`,
        };
      }
      if (contract.capability_plan_digest !== context.plan_digest) {
        return {
          status: "blocked",
          reason: "tdd_contract_binding_drift",
          detail: `TaskTddContract ${contract.contract_id} binds a different CapabilityPlan`,
        };
      }
      if (contract.contract_mode === "required") {
        const outcome = await ports.strictTdd.runTask({
          task,
          contract,
          capability_plan_digest: context.plan_digest,
        });
        outcomes.push(outcome);
        if (outcome.status !== "completed") {
          return {
            status: "blocked",
            reason: "tdd_incomplete_or_invalid",
            detail: outcome.reason,
          };
        }
        continue;
      }
      if (contract.contract_mode === "not_applicable") {
        const accepted =
          ports.acceptedDesignBinding(contract, context) &&
          context.inputs["design_set"] === contract.design_set_digest &&
          contract.test_strategy_digest.length === 64;
        if (!accepted) {
          return {
            status: "blocked",
            reason: "tdd_binding_not_accepted",
            detail: `controlled exemption for ${task.id} is not bound to the accepted DesignSet/test strategy`,
          };
        }
        await ports.executeNormally(task, context);
        outcomes.push({ task_id: task.id, tdd_verdict: "controlled_not_applicable" });
        continue;
      }
      return {
        status: "blocked",
        reason: "tdd_framework_bootstrap_required",
        detail: `framework bootstrap task ${task.id} requires a framework evidence runner`,
      };
    }
    for (const outcome of outcomes) await ports.onTaskOutcome?.(outcome);
    if (!strict) return { status: "committed" };
    return {
      status: "committed",
      produces: [
        {
          kind: "tdd_contract",
          digest: contentDigest(
            outcomes.map((outcome) => ({
              task_id: outcome.task_id,
              tdd_verdict: outcome.tdd_verdict,
              ...("cycle" in outcome && outcome.cycle.record_digest !== undefined
                ? { cycle_digest: outcome.cycle.record_digest }
                : {}),
            })),
          ),
        },
      ],
    };
  };
}
