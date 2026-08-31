import {
  contentDigest,
  type TaskTddContract,
  type TddCycleRecord,
  type TddEvidenceBinding,
  type TddPhaseBudget,
} from "@universal-harness-internal/core";

import type { TaskSpecification } from "../planning/task.js";
import type { CapabilityGrant, GrantBudget } from "../policy/capability-grant.js";
import type { EffectivePolicy } from "../policy/decision.js";
import {
  acceptBaselineEvidence,
  acceptGreenEvidence,
  acceptRedEvidence,
  acceptRefactorEvidence,
  buildTddCycleRecord,
  createTddCycle,
  freezeTestPatch,
  terminateTddCycle,
  type StructuredTestResult,
  type TddEvidenceIssue,
} from "./controller.js";
import {
  issueTddPhaseGrant,
  effectiveTddWriteScopes,
  tddPhaseWriteScopes,
} from "./phase-grants.js";
import { attestWriteSet, canonicalTestPatch, classifyPath, type PatchFile } from "./patch.js";
import type { IsolatedWorkspacePort, WorkspaceHandle } from "./workspace.js";

export interface StrictTddGateObservation {
  readonly result: StructuredTestResult;
  readonly target_gate_binding_digest: string;
  readonly framework_profile_digest: string;
  readonly executor_environment_digest: string;
  readonly output_artifact: { readonly locator: string; readonly digest: string };
}

export interface StrictTddGatePort {
  run(input: {
    readonly phase: "baseline" | "red" | "green" | "refactor";
    readonly task: TaskSpecification;
    readonly contract: TaskTddContract;
    readonly workspace: WorkspaceHandle;
    readonly gate_id: string;
    readonly selectors: readonly string[];
    readonly grant: CapabilityGrant;
  }): Promise<StrictTddGateObservation>;
}

interface TddAgentPhaseInput {
  readonly task: TaskSpecification;
  readonly contract: TaskTddContract;
  readonly workspace: WorkspaceHandle;
  readonly grant: CapabilityGrant;
}

export interface StrictTddPhaseExecutorPort {
  authorTests(input: TddAgentPhaseInput): Promise<{ readonly files: readonly PatchFile[] }>;
  implement(
    input: TddAgentPhaseInput & {
      readonly accepted_red_evidence_digest: string;
    },
  ): Promise<{
    readonly files: readonly PatchFile[];
    readonly implementation_revision: string;
  }>;
  refactor?(
    input: TddAgentPhaseInput & {
      readonly accepted_green_evidence_digest: string;
      readonly implementation_revision: string;
    },
  ): Promise<{
    readonly files: readonly PatchFile[];
    readonly implementation_revision: string;
  }>;
}

export interface TddEvidenceStore {
  listCycles(logicalCycleId: string): readonly TddCycleRecord[];
  listEvidence(logicalCycleId: string): readonly TddEvidenceBinding[];
  appendEvidence(evidence: TddEvidenceBinding): void | Promise<void>;
  appendCycle(record: TddCycleRecord): void | Promise<void>;
}

export interface InMemoryTddEvidenceStore extends TddEvidenceStore {
  readonly evidence: readonly TddEvidenceBinding[];
  readonly cycles: readonly TddCycleRecord[];
}

export function createInMemoryTddEvidenceStore(): InMemoryTddEvidenceStore {
  const evidence: TddEvidenceBinding[] = [];
  const cycles: TddCycleRecord[] = [];
  return {
    get evidence() {
      return [...evidence];
    },
    get cycles() {
      return [...cycles];
    },
    listCycles(logicalCycleId) {
      return cycles.filter((record) => record.logical_cycle_id === logicalCycleId);
    },
    listEvidence(logicalCycleId) {
      return evidence.filter((record) => record.logical_cycle_id === logicalCycleId);
    },
    appendEvidence(record) {
      const digest = contentDigest(record);
      if (!evidence.some((entry) => contentDigest(entry) === digest)) evidence.push(record);
    },
    appendCycle(record) {
      if (
        cycles.some(
          (entry) =>
            entry.logical_cycle_id === record.logical_cycle_id &&
            entry.attempt_ordinal === record.attempt_ordinal,
        )
      ) {
        throw new Error(
          `immutable TDD attempt already exists: ${record.logical_cycle_id}/${String(record.attempt_ordinal)}`,
        );
      }
      cycles.push(record);
    },
  };
}

export type StrictTddTaskOutcome =
  | {
      readonly status: "completed";
      readonly task_id: string;
      readonly tdd_verdict: "tdd_proven";
      readonly cycle: TddCycleRecord;
      readonly evidence: readonly TddEvidenceBinding[];
      readonly grants: readonly CapabilityGrant[];
      readonly implementation_revision: string;
      readonly replayed?: boolean;
    }
  | {
      readonly status: "blocked";
      readonly task_id: string;
      readonly tdd_verdict: "tdd_incomplete_or_invalid";
      readonly cycle: TddCycleRecord;
      readonly evidence: readonly TddEvidenceBinding[];
      readonly grants: readonly CapabilityGrant[];
      readonly issues: readonly TddEvidenceIssue[];
      readonly reason: string;
    };

export interface StrictTddExecutionPort {
  runTask(input: {
    readonly task: TaskSpecification;
    readonly contract: TaskTddContract;
    readonly capability_plan_digest: string;
  }): Promise<StrictTddTaskOutcome>;
}

export interface StrictTddExecutionRunnerOptions {
  readonly workspace: IsolatedWorkspacePort;
  readonly gate: StrictTddGatePort;
  readonly executor: StrictTddPhaseExecutorPort;
  readonly evidence: TddEvidenceStore;
  readonly effectivePolicy: EffectivePolicy;
  readonly readBaseline: () => string;
}

function budgetOf(phase: TddPhaseBudget, fallback: GrantBudget): GrantBudget {
  return {
    steps: phase.max_steps ?? phase.max_runs ?? fallback.steps,
    tokens: phase.max_tokens ?? fallback.tokens,
  };
}

function gatePassed(result: StructuredTestResult): boolean {
  return (
    result.outcome === "structured" &&
    result.runs.length > 0 &&
    result.runs.every((run) => run.status === "passed")
  );
}

function evidenceInput(
  observation: StrictTddGateObservation,
  grant: CapabilityGrant,
  diff: readonly PatchFile[],
) {
  return {
    target_gate_binding_digest: observation.target_gate_binding_digest,
    framework_profile_digest: observation.framework_profile_digest,
    executor_environment_digest: observation.executor_environment_digest,
    grant_digest: grant.digest,
    observed_write_set_digest: contentDigest(
      diff.map((file) => ({ path: file.path, content_digest: contentDigest(file.content) })),
    ),
    output_artifact: observation.output_artifact,
  };
}

function asIssue(code: TddEvidenceIssue["code"], message: string): TddEvidenceIssue {
  return { code, message };
}

/**
 * Execute one required Task as a reconstructable Baseline/Red/Green chain.
 * Every workspace begins at the same baseline; only the frozen test patch is
 * carried across phases. Production writes are impossible until the
 * controller has accepted Red and its digest unlocks a new implementation
 * grant.
 */
export function createStrictTddExecutionRunner(
  options: StrictTddExecutionRunnerOptions,
): StrictTddExecutionPort {
  return {
    async runTask(input): Promise<StrictTddTaskOutcome> {
      const { task, contract } = input;
      if (contract.contract_mode !== "required" || contract.assertion_clusters.length !== 1) {
        throw new Error("StrictTddExecutionPort accepts required contracts with one cluster only");
      }
      if (contract.task_id !== task.id) throw new Error("TDD contract task binding drift");
      if (contract.capability_plan_digest !== input.capability_plan_digest) {
        throw new Error("TDD contract CapabilityPlan binding drift");
      }
      const cluster = contract.assertion_clusters[0]!;
      const previous = options.evidence.listCycles(cluster.logical_cycle_id);
      const completed = previous.find(
        (record) =>
          record.status === "completed" && record.contract_digest === contract.contract_digest,
      );
      if (completed !== undefined) {
        return {
          status: "completed",
          task_id: task.id,
          tdd_verdict: "tdd_proven",
          cycle: completed,
          evidence: options.evidence.listEvidence(cluster.logical_cycle_id),
          grants: [],
          implementation_revision: completed.implementation_revision!,
          replayed: true,
        };
      }

      let view = createTddCycle({
        task_id: task.id,
        assertion_ids: cluster.assertion_ids,
        contract_digest: contract.contract_digest,
        repository_baseline: options.readBaseline(),
        logical_cycle_id: cluster.logical_cycle_id,
        attempt_ordinal: Math.max(0, ...previous.map((record) => record.attempt_ordinal)) + 1,
      });
      const grants: CapabilityGrant[] = [];
      const handles: WorkspaceHandle[] = [];
      const accepted: TddEvidenceBinding[] = [];
      const fallback = task.budget;

      const phaseGrant = (
        state: Parameters<typeof issueTddPhaseGrant>[0]["state"],
        budget: GrantBudget,
        proof_digest?: string,
      ): CapabilityGrant => {
        const issued = issueTddPhaseGrant(
          {
            state,
            task_id: task.id,
            policy: cluster.path_policy,
            budget,
            effective: options.effectivePolicy,
            ...(proof_digest === undefined ? {} : { proof_digest }),
          },
          grants,
        );
        if (!issued.reused) grants.push(issued.grant);
        return issued.grant;
      };
      const createWorkspace = async (
        purpose: Parameters<IsolatedWorkspacePort["create"]>[0]["purpose"],
      ): Promise<WorkspaceHandle> => {
        const handle = await options.workspace.create({
          baseline_commit: view.repository_baseline,
          purpose,
        });
        handles.push(handle);
        return handle;
      };
      /**
       * M4 design 12 / plan Task 7 step 4: for a Protocol 1.3 task the write
       * set of every writing phase is the true path-scope intersection
       * Task.write_paths ∩ phase policy scopes ∩ phase grant (the runner's
       * phase grant doubles as the task grant here). Legacy tasks without
       * declared write_paths keep the pre-M4 grant-only behavior. An empty
       * intersection must block the phase before any executor runs.
       */
      const effectivePhaseScopes = (
        state: "test_authoring" | "implementation" | "refactor",
        grant: CapabilityGrant,
      ): readonly string[] | undefined => {
        if (task.write_paths === undefined) return undefined;
        return effectiveTddWriteScopes({
          task_write_paths: task.write_paths,
          task_grant_write_paths: grant.write_paths,
          phase_policy_write_paths: tddPhaseWriteScopes(state, cluster.path_policy),
          phase_grant_write_paths: grant.write_paths,
        });
      };
      const emptyScopeStop = (
        state: "test_authoring" | "implementation" | "refactor",
      ): Promise<StrictTddTaskOutcome> =>
        stop(`empty effective write scope for ${state}`, [
          asIssue(
            "write_set_violation",
            `Task.write_paths leaves no writable path for phase ${state}; blocking before execution`,
          ),
        ]);
      const persistEvidence = async (value: TddEvidenceBinding): Promise<void> => {
        await options.evidence.appendEvidence(value);
        accepted.push(value);
      };
      const stop = async (
        reason: string,
        issues: readonly TddEvidenceIssue[],
        status: "blocked" | "invalidated" = "blocked",
      ): Promise<StrictTddTaskOutcome> => {
        view = terminateTddCycle(view, { status, reason });
        const cycle = buildTddCycleRecord(view);
        await options.evidence.appendCycle(cycle);
        return {
          status: "blocked",
          task_id: task.id,
          tdd_verdict: "tdd_incomplete_or_invalid",
          cycle,
          evidence: [...accepted],
          grants: [...grants],
          issues,
          reason,
        };
      };

      try {
        const authorBudget = budgetOf(contract.phase_budgets.test_authoring, fallback);
        const implementationBudget = budgetOf(contract.phase_budgets.implementation, fallback);
        const baselineWorkspace = await createWorkspace("baseline");
        const baselineGrant = phaseGrant("baseline_guard", authorBudget);
        const baselineObservation = await options.gate.run({
          phase: "baseline",
          task,
          contract,
          workspace: baselineWorkspace,
          gate_id: cluster.target_gate_id,
          selectors: cluster.target_test_selectors,
          grant: baselineGrant,
        });
        if (baselineObservation.framework_profile_digest !== cluster.framework_profile_digest) {
          return stop("baseline framework profile drift", [
            asIssue("binding_drift", "baseline framework profile does not match the TDD contract"),
          ]);
        }
        const baselineDiff = await options.workspace.diff(baselineWorkspace);
        if (baselineDiff.length > 0) {
          return stop("baseline workspace was modified", [
            asIssue("write_set_violation", "baseline guard must be read-only"),
          ]);
        }
        const baseline = acceptBaselineEvidence(view, {
          ...evidenceInput(baselineObservation, baselineGrant, baselineDiff),
          gate_passed: gatePassed(baselineObservation.result),
        });
        view = baseline.next;
        if (view.baseline_evidence !== undefined) await persistEvidence(view.baseline_evidence);
        if (baseline.issues.length > 0 || view.state === "blocked") {
          return stop(view.block_reason ?? "baseline evidence rejected", baseline.issues);
        }

        const authorWorkspace = await createWorkspace("test_authoring");
        const authorGrant = phaseGrant("test_authoring", authorBudget);
        const authorScopes = effectivePhaseScopes("test_authoring", authorGrant);
        if (authorScopes !== undefined && authorScopes.length === 0) {
          return emptyScopeStop("test_authoring");
        }
        const authored = await options.executor.authorTests({
          task,
          contract,
          workspace: authorWorkspace,
          grant: authorGrant,
        });
        if (authorScopes !== undefined) {
          const authorViolations = attestWriteSet(
            authored.files.map((file) => file.path),
            authorScopes,
          );
          if (authorViolations.length > 0) {
            return stop("test authoring wrote outside the effective write scope", [
              asIssue("write_set_violation", authorViolations.join(", ")),
            ]);
          }
        }
        await options.workspace.applyFiles(authorWorkspace, authored.files);
        const testPatch = await options.workspace.diff(authorWorkspace);
        const frozen = freezeTestPatch(view, testPatch, cluster.path_policy);
        if (frozen.issues.length > 0) {
          return stop("test-authoring patch violates the approved path policy", frozen.issues);
        }
        view = frozen.next;

        const redWorkspace = await createWorkspace("red_verification");
        await options.workspace.applyFiles(redWorkspace, testPatch);
        const redGrant = phaseGrant("red_verification", authorBudget);
        const redObservation = await options.gate.run({
          phase: "red",
          task,
          contract,
          workspace: redWorkspace,
          gate_id: cluster.target_gate_id,
          selectors: cluster.target_test_selectors,
          grant: redGrant,
        });
        const redDiff = await options.workspace.diff(redWorkspace);
        if (canonicalTestPatch(redDiff).patch_digest !== frozen.patch_digest) {
          return stop("red workspace cannot be reconstructed from the frozen patch", [
            asIssue("patch_drift", "red workspace diff differs from the frozen test patch"),
          ]);
        }
        const red = acceptRedEvidence(view, {
          ...evidenceInput(redObservation, redGrant, redDiff),
          test_patch_digest: frozen.patch_digest,
          oracle: cluster.failure_oracle,
          result: redObservation.result,
        });
        if (red.issues.length > 0 || red.next.red_evidence === undefined) {
          return stop("RedEvidence was not accepted", red.issues);
        }
        view = red.next;
        await persistEvidence(view.red_evidence!);

        const redDigest = contentDigest(view.red_evidence);
        const implementationWorkspace = await createWorkspace("implementation");
        await options.workspace.applyFiles(implementationWorkspace, testPatch);
        const implementationGrant = phaseGrant("implementation", implementationBudget, redDigest);
        const implementationScopes = effectivePhaseScopes("implementation", implementationGrant);
        if (implementationScopes !== undefined && implementationScopes.length === 0) {
          return emptyScopeStop("implementation");
        }
        const implementation = await options.executor.implement({
          task,
          contract,
          workspace: implementationWorkspace,
          grant: implementationGrant,
          accepted_red_evidence_digest: redDigest,
        });
        const implementationViolations = attestWriteSet(
          implementation.files.map((file) => file.path),
          implementationScopes ?? implementationGrant.write_paths,
        );
        if (implementationViolations.length > 0) {
          return stop("implementation wrote outside the effective write scope", [
            asIssue("write_set_violation", implementationViolations.join(", ")),
          ]);
        }
        await options.workspace.applyFiles(implementationWorkspace, implementation.files);
        const implementationDiff = await options.workspace.diff(implementationWorkspace);
        const preservedPatch = implementationDiff.filter(
          (file) => classifyPath(file.path, cluster.path_policy) !== "production",
        );
        if (canonicalTestPatch(preservedPatch).patch_digest !== frozen.patch_digest) {
          return stop("implementation changed the accepted test patch", [
            asIssue("patch_drift", "implementation must reuse the frozen test patch verbatim"),
          ]);
        }
        const greenObservation = await options.gate.run({
          phase: "green",
          task,
          contract,
          workspace: implementationWorkspace,
          gate_id: cluster.target_gate_id,
          selectors: cluster.target_test_selectors,
          grant: implementationGrant,
        });
        const green = acceptGreenEvidence(view, {
          ...evidenceInput(greenObservation, implementationGrant, implementationDiff),
          test_patch_digest: frozen.patch_digest,
          oracle: cluster.failure_oracle,
          result: greenObservation.result,
          production_write_set: implementation.files.map((file) => file.path),
          implementation_write_scopes: implementationGrant.write_paths,
          implementation_revision: implementation.implementation_revision,
          refactor_planned: cluster.refactor_policy === "planned",
        });
        if (green.issues.length > 0 || green.next.green_evidence === undefined) {
          return stop("GreenEvidence was not accepted", green.issues);
        }
        view = green.next;
        await persistEvidence(view.green_evidence!);

        if (cluster.refactor_policy === "planned") {
          if (
            options.executor.refactor === undefined ||
            contract.phase_budgets.refactor === undefined
          ) {
            return stop("planned refactor has no executor or budget", [
              asIssue("state_order", "planned refactor requires an explicit executor and budget"),
            ]);
          }
          const greenDigest = contentDigest(view.green_evidence);
          const refactorWorkspace = await createWorkspace("refactor");
          await options.workspace.applyFiles(refactorWorkspace, [
            ...testPatch,
            ...implementation.files,
          ]);
          const refactorGrant = phaseGrant(
            "refactor",
            budgetOf(contract.phase_budgets.refactor, fallback),
            greenDigest,
          );
          const refactorScopes = effectivePhaseScopes("refactor", refactorGrant);
          if (refactorScopes !== undefined && refactorScopes.length === 0) {
            return emptyScopeStop("refactor");
          }
          const refactored = await options.executor.refactor({
            task,
            contract,
            workspace: refactorWorkspace,
            grant: refactorGrant,
            accepted_green_evidence_digest: greenDigest,
            implementation_revision: implementation.implementation_revision,
          });
          const refactorViolations = attestWriteSet(
            refactored.files.map((file) => file.path),
            refactorScopes ?? refactorGrant.write_paths,
          );
          if (refactorViolations.length > 0) {
            return stop("refactor wrote outside the effective write scope", [
              asIssue("write_set_violation", refactorViolations.join(", ")),
            ]);
          }
          await options.workspace.applyFiles(refactorWorkspace, refactored.files);
          const refactorDiff = await options.workspace.diff(refactorWorkspace);
          const refactorObservation = await options.gate.run({
            phase: "refactor",
            task,
            contract,
            workspace: refactorWorkspace,
            gate_id: cluster.target_gate_id,
            selectors: cluster.target_test_selectors,
            grant: refactorGrant,
          });
          const refactor = acceptRefactorEvidence(view, {
            ...evidenceInput(refactorObservation, refactorGrant, refactorDiff),
            test_patch_digest: frozen.patch_digest,
            oracle: cluster.failure_oracle,
            result: refactorObservation.result,
            production_write_set: refactored.files.map((file) => file.path),
            refactor_write_scopes: refactorGrant.write_paths,
            implementation_revision: refactored.implementation_revision,
          });
          if (refactor.issues.length > 0 || refactor.next.refactor_evidence === undefined) {
            return stop("RefactorEvidence was not accepted", refactor.issues);
          }
          view = refactor.next;
          await persistEvidence(view.refactor_evidence!);
        }

        const cycle = buildTddCycleRecord(view);
        await options.evidence.appendCycle(cycle);
        return {
          status: "completed",
          task_id: task.id,
          tdd_verdict: "tdd_proven",
          cycle,
          evidence: [...accepted],
          grants: [...grants],
          implementation_revision: cycle.implementation_revision!,
        };
      } catch (error) {
        return stop(
          `TDD attempt crashed: ${error instanceof Error ? error.message : String(error)}`,
          [asIssue("state_order", "phase crash invalidated the current attempt")],
          "invalidated",
        );
      } finally {
        await Promise.all(
          handles.map(async (handle) => {
            try {
              await options.workspace.destroy(handle);
            } catch {
              /* best-effort cleanup */
            }
          }),
        );
      }
    },
  };
}
