import {
  assertCapabilityPlanFinal,
  type CapabilityPlanRecord,
} from "@universal-harness-internal/core";

import {
  WorkflowDagEngine,
  type DagRunOutcome,
  type WorkflowDagEngineConfig,
} from "../workflow/dag-engine.js";
import type { DagCheckpointStore, DagRunnerRegistry } from "../workflow/dag.js";

export interface CapabilityDagRuntimeDependencies {
  readonly store: DagCheckpointStore;
  readonly runners: DagRunnerRegistry;
  readonly onEvent?: WorkflowDagEngineConfig["onEvent"];
}

export interface CapabilityDagRuntimeInput {
  readonly operation_id: string;
  readonly plan?: CapabilityPlanRecord;
}

export type CapabilityDagRuntimeOutcome =
  | DagRunOutcome
  | {
      readonly status: "blocked";
      readonly operation_id: string;
      readonly node_id: "capability_decision";
      readonly reason: "capability_plan_required" | "capability_plan_binding_drift";
      readonly detail: string;
    };

export interface CapabilityDagRuntime {
  run(input: CapabilityDagRuntimeInput): Promise<CapabilityDagRuntimeOutcome>;
}

/**
 * Protocol 1.1 router. Capture may bootstrap before this call; once a plan is
 * supplied, only its operation_dag is handed to WorkflowDagEngine. A changed
 * unrelated plan digest invalidates the journal, while the exact
 * provisional→final supersession lineage may replay its valid prefix.
 */
export function createCapabilityDagRuntime(
  dependencies: CapabilityDagRuntimeDependencies,
): CapabilityDagRuntime {
  return {
    async run(input): Promise<CapabilityDagRuntimeOutcome> {
      const plan = input.plan;
      if (plan === undefined) {
        return {
          status: "blocked",
          operation_id: input.operation_id,
          node_id: "capability_decision",
          reason: "capability_plan_required",
          detail: "Protocol 1.1 requires an accepted CapabilityPlan before routing",
        };
      }
      if (plan.operation_id !== input.operation_id) {
        return {
          status: "blocked",
          operation_id: input.operation_id,
          node_id: "capability_decision",
          reason: "capability_plan_binding_drift",
          detail: "CapabilityPlan operation binding does not match the running operation",
        };
      }

      const currentJournal = await dependencies.store.load(input.operation_id);
      const previousPlanDigests = new Set(currentJournal.map((entry) => entry.plan_digest));
      const replayable = new Set([plan.record_digest, plan.supersedes_digest].filter(Boolean));
      if ([...previousPlanDigests].some((digest) => !replayable.has(digest))) {
        await dependencies.store.truncate(input.operation_id, 0);
      }

      const planRunner = dependencies.runners.kernel["plan"];
      const guardedRunners: DagRunnerRegistry = {
        ...dependencies.runners,
        kernel: {
          ...dependencies.runners.kernel,
          plan: (context) => {
            try {
              assertCapabilityPlanFinal(plan);
            } catch {
              return {
                status: "blocked",
                reason: "capability_plan_not_final",
                detail: "a provisional or deferred CapabilityPlan cannot enter Plan",
              };
            }
            if (planRunner === undefined) {
              return {
                status: "blocked",
                reason: "missing_node_runner",
                detail: "no Plan runner is registered",
              };
            }
            return planRunner(context);
          },
        },
      };
      return new WorkflowDagEngine({
        store: dependencies.store,
        runners: guardedRunners,
        ...(dependencies.onEvent === undefined ? {} : { onEvent: dependencies.onEvent }),
      }).run({
        operation_id: input.operation_id,
        plan_digest: plan.record_digest,
        nodes: plan.operation_dag.nodes,
      });
    },
  };
}
