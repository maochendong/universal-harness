import type { ContextBundleRecord } from "../context/compiler.js";
import { TaskBundleBindingError, assertTaskBundleBinding } from "../context/task-bundles.js";
import type { GovernanceRisk } from "../planning/effective-risk.js";
import type { CapabilityGrantSpec } from "./capability-grant.js";
import {
  authorizationSpecDigest,
  type ExecutionAuthorizationSpec,
} from "./execution-authorization.js";

export type ExecutionPreflightErrorKind =
  "missing_binding" | "binding_drift" | "impact_coverage_incomplete";

export class ExecutionPreflightError extends Error {
  readonly kind: ExecutionPreflightErrorKind;

  constructor(kind: ExecutionPreflightErrorKind, message: string) {
    super(message);
    this.name = "ExecutionPreflightError";
    this.kind = kind;
  }
}

export interface ExecutionPreflightInput {
  readonly authorizationId: string;
  readonly iterationId: string;
  readonly planDigest: string;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly taskDigest: string;
    readonly risk: GovernanceRisk;
  }[];
  readonly impactSetDigest: string;
  readonly impactCoverageDigest: string;
  readonly impactCoverageStatus: "complete" | "partial" | "unknown";
  readonly bundles: readonly ContextBundleRecord[];
  readonly grantSpecs: readonly CapabilityGrantSpec[];
  readonly policyDigest: string;
  readonly adapterProfileDigest?: string;
  /**
   * The accepted DesignSet content digest when design_governance is active;
   * every task bundle must carry the same binding. Undefined means the
   * capability is off and bundles must NOT carry the binding.
   */
  readonly designSetDigest?: string;
  readonly baselineCommit: string;
  readonly requiresWrite: boolean;
  readonly opaqueDelegated: boolean;
}

export interface PreparedExecutionPreflight {
  readonly authorizationSpec: ExecutionAuthorizationSpec;
  readonly supervised: boolean;
}

const RISK_ORDER: readonly GovernanceRisk[] = ["low", "medium", "high", "critical"];

export function prepareExecutionPreflight(
  input: ExecutionPreflightInput,
): PreparedExecutionPreflight {
  if (input.requiresWrite && input.impactCoverageStatus !== "complete") {
    throw new ExecutionPreflightError(
      "impact_coverage_incomplete",
      `agent write execution requires complete impact coverage, got ${input.impactCoverageStatus}`,
    );
  }
  const bundleByTask = new Map(input.bundles.map((bundle) => [bundle.task_id, bundle]));
  const grantByTask = new Map(input.grantSpecs.map((grant) => [grant.task_id, grant]));
  if (
    bundleByTask.size !== input.tasks.length ||
    grantByTask.size !== input.tasks.length ||
    input.tasks.length === 0
  ) {
    throw new ExecutionPreflightError(
      "missing_binding",
      "every execution task requires exactly one context bundle and one GrantSpec",
    );
  }
  for (const task of input.tasks) {
    const bundle = bundleByTask.get(task.taskId);
    const grant = grantByTask.get(task.taskId);
    if (bundle === undefined || grant === undefined) {
      throw new ExecutionPreflightError(
        "missing_binding",
        `task ${task.taskId} is missing its context bundle or GrantSpec`,
      );
    }
    try {
      assertTaskBundleBinding(bundle, {
        taskId: task.taskId,
        taskDigest: task.taskDigest,
        planDigest: input.planDigest,
        impactCoverageDigest: input.impactCoverageDigest,
        ...(input.designSetDigest === undefined ? {} : { designSetDigest: input.designSetDigest }),
      });
    } catch (error) {
      if (error instanceof TaskBundleBindingError) {
        throw new ExecutionPreflightError("binding_drift", error.message);
      }
      throw error;
    }
    if (
      grant.plan_digest !== input.planDigest ||
      grant.context_bundle_digest !== bundle.digest ||
      grant.effective_policy_digest !== input.policyDigest ||
      grant.baseline_commit !== input.baselineCommit ||
      grant.adapter_profile_digest !== input.adapterProfileDigest
    ) {
      throw new ExecutionPreflightError(
        "binding_drift",
        `GrantSpec ${grant.grant_id} does not match the plan execution bindings`,
      );
    }
  }
  const effectiveRisk = input.tasks.reduce<GovernanceRisk>(
    (risk, task) => (RISK_ORDER.indexOf(task.risk) > RISK_ORDER.indexOf(risk) ? task.risk : risk),
    input.opaqueDelegated ? "high" : "low",
  );
  const base = {
    authorization_id: input.authorizationId,
    iteration_id: input.iterationId,
    plan_digest: input.planDigest,
    task_digests: input.tasks.map((task) => task.taskDigest).sort(),
    impact_set_digest: input.impactSetDigest,
    impact_coverage_digest: input.impactCoverageDigest,
    context_bundle_digests: input.bundles.map((bundle) => bundle.digest).sort(),
    grant_spec_digests: input.grantSpecs.map((grant) => grant.spec_digest).sort(),
    policy_digest: input.policyDigest,
    ...(input.adapterProfileDigest === undefined
      ? {}
      : { adapter_profile_digest: input.adapterProfileDigest }),
    ...(input.designSetDigest === undefined ? {} : { design_set_digest: input.designSetDigest }),
    baseline_commit: input.baselineCommit,
    effective_risk: effectiveRisk,
  };
  return {
    authorizationSpec: { ...base, spec_digest: authorizationSpecDigest(base) },
    supervised: input.opaqueDelegated,
  };
}
