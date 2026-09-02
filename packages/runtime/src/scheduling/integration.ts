import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PROTOCOL_1_3_VERSION,
  buildWaveIntegrationRecord,
  contentDigest,
  type FeedbackRecord,
  type TaskLeaseRecord,
  type WaveIntegrationRecord,
} from "@universal-harness-internal/core";

import { readGateEvidenceExtension, type GateEvidenceRecord } from "../gates/evidence.js";
import { evidenceStalenessReasons } from "../gates/freshness.js";
import type { GateDefinition } from "../gates/provider.js";
import type { ParallelWave } from "../planning/waves.js";
import { taskSemanticDigest, type Protocol13TaskSpecification } from "../planning/task.js";
import { actionDigest, type AdapterControlProfile } from "../policy/action.js";
import type { PolicyDecision } from "../policy/decision.js";
import { isPathWithinScopes } from "../policy/path-boundary.js";

import { remainingBudget, restoreBudgetAccount } from "./budget.js";
import {
  taskCandidateValidatedEvent,
  taskRetryScheduledEvent,
  waveGateCompletedEvent,
  waveIntegratedEvent,
} from "./events.js";
import { buildTaskLeaseChain, terminateTaskLease } from "./lease.js";
import { schedulerPolicyAction } from "./policy-adapters.js";
import type { SchedulerPolicyInput, TaskDagSnapshot } from "./ports.js";
import { deriveIterationDeadline, type SchedulerAuthority } from "./scheduler.js";
import type { TaskCandidatePatch } from "./workspace-manager.js";

/**
 * Candidate integration controller (M4 design §13/§14, plan Task 10 step 2/4/6).
 *
 * The Workflow Engine — never an Agent — owns candidate integration. Queued
 * Task patches are applied onto a disposable candidate worktree in Plan order
 * (`git apply --index` + Harness-owned commits with fixed identity/message
 * inputs; never agent commit metadata, never --3way/merge/rebase/force).
 * Validation is three-layered: task workspace evidence (supplied, re-checked
 * for bindings and freshness) → candidate-tree gates → wave Mandatory Gates.
 * Acceptance revalidates Plan/Task, Policy/Approval, gate definitions,
 * Evidence freshness, Lease fencing and the expected base OID immediately
 * before one staged commit of the WaveIntegrationRecord plus the
 * operation-local ref CAS (Ledger first, ref second — code never advances
 * without its Ledger record).
 *
 * `accepted_source_tree_digest` digests the project source tree only; the
 * `.harness` Ledger content is excluded so the record never references a
 * commit containing itself (design §14).
 *
 * Deviation from plan Task 10 step 4 wording: `queueTaskCandidate()` does not
 * write the TaskIntegrationQueued event — the Task 9 scheduler already commits
 * it atomically with the run/lease transitions at candidate collection, and a
 * second write would duplicate the timeline. The queue is an in-memory
 * integration buffer; recovery re-populates it from Ledger facts
 * (`SchedulerLedgerFacts.candidate_patches`).
 */
export const CANDIDATE_INTEGRATION_ERROR_KINDS = [
  "wave_base_mismatch",
  "baseline_drift",
  "missing_candidate",
  "patch_digest_mismatch",
  "integration_conflict",
  "task_not_in_wave",
  "candidate_not_validated",
  "undeclared_write",
  "lease_not_current",
  "lease_not_released",
  "evidence_binding_mismatch",
  "evidence_stale",
  "policy_not_allowed",
  "approval_not_satisfied",
  "wave_gate_failed",
  "command_conflict",
  "ref_cas_failed",
  "operation_lease_required",
  "publish_failed",
] as const;

export type CandidateIntegrationErrorKind = (typeof CANDIDATE_INTEGRATION_ERROR_KINDS)[number];

/** Fail-closed rejection raised by the candidate integration controller. */
export class CandidateIntegrationError extends Error {
  readonly kind: CandidateIntegrationErrorKind;

  constructor(kind: CandidateIntegrationErrorKind, message: string) {
    super(message);
    this.name = "CandidateIntegrationError";
    this.kind = kind;
  }
}

/** The operation-local integration ref (design §22; unconnected mode name). */
export function operationRefFor(operationId: string): string {
  return `refs/heads/operation/${operationId}`;
}

// --- Scheduling evidence bindings ------------------------------------------

/**
 * M4 scheduling binding carried in a gate evidence extension (design §13.2):
 * the actual commit, Plan/Task digests, Run and Lease fencing token the
 * verdict observed. `layer` classifies the record: "task" (execution
 * workspace), "candidate" (task patch on the candidate tree) or "wave"
 * (Mandatory Gates on the complete candidate). Task/candidate layers bind a
 * Run and Lease; wave evidence is bound to the Plan and candidate commit.
 */
export const SCHEDULING_EVIDENCE_EXTENSION_KEY = "harness.scheduling";

export interface SchedulingEvidenceBinding {
  readonly plan_digest: string;
  readonly task_digest?: string;
  readonly task_id?: string;
  readonly run_id?: string;
  readonly lease_id?: string;
  readonly fencing_token?: number;
  readonly commit: string;
  readonly layer: "task" | "candidate" | "wave";
}

/** Attach the scheduling binding and seal it into the scheduling Evidence digest. */
export function bindSchedulingEvidence(
  record: GateEvidenceRecord,
  binding: SchedulingEvidenceBinding,
): GateEvidenceRecord {
  const extensions = {
    ...record.extensions,
    [SCHEDULING_EVIDENCE_EXTENSION_KEY]: { ...binding },
  };
  return {
    ...record,
    // The generic Gate digest seals the normalized outcome/bindings. The M4
    // digest additionally seals Plan/Task/Run/Lease/workspace-layer identity,
    // so mutating metadata can never preserve an accepted Evidence digest.
    digest: contentDigest({ gate_evidence_digest: record.digest, scheduling_binding: binding }),
    extensions,
  };
}

/** The scheduling binding of an evidence record, or undefined when absent. */
export function schedulingEvidenceBindingOf(
  record: GateEvidenceRecord,
): SchedulingEvidenceBinding | undefined {
  const extension = record.extensions?.[SCHEDULING_EVIDENCE_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) return undefined;
  const candidate = extension as Partial<SchedulingEvidenceBinding>;
  if (
    typeof candidate.plan_digest !== "string" ||
    typeof candidate.commit !== "string" ||
    (candidate.layer !== "task" && candidate.layer !== "candidate" && candidate.layer !== "wave")
  ) {
    return undefined;
  }
  return candidate as SchedulingEvidenceBinding;
}

// --- Git port ----------------------------------------------------------------

/**
 * The low-level git operations candidate integration needs. The production
 * implementation (`createGitWaveIntegrationGit`) runs exact git argument
 * arrays against the real repository; fault-injection tests substitute a
 * failing wrapper. No operation here ever forces, merges, rebases or applies
 * with --3way.
 */
export interface WaveIntegrationGitPort {
  /** Disposable detached worktree at the wave base; returns its root. */
  createCandidateWorktree(input: {
    readonly base_commit: string;
    readonly wave_index: number;
  }): Promise<string>;
  /**
   * Verify the patch artifact digest and apply it with `git apply --index`.
   * A digest mismatch throws `patch_digest_mismatch`; a failed apply throws
   * `integration_conflict` (both as CandidateIntegrationError).
   */
  applyManagedPatch(input: {
    readonly worktree_root: string;
    readonly patch: TaskCandidatePatch;
  }): Promise<void>;
  /** Harness-owned commit of the staged task patch; returns the commit OID. */
  commitCandidate(input: {
    readonly worktree_root: string;
    readonly task_id: string;
    readonly message: string;
  }): Promise<string>;
  discardWorktree(root: string): Promise<void>;
  /** Current OID of a ref; undefined when the ref does not exist. */
  readRef(ref: string): Promise<string | undefined>;
  /**
   * Compare-and-swap a ref: `expected` undefined means create-only. Returns
   * false without side effects when the ref does not hold `expected`.
   */
  compareAndSwapRef(input: {
    readonly ref: string;
    readonly expected: string | undefined;
    /** Undefined deletes the ref and is used only to roll back a failed acceptance. */
    readonly next: string | undefined;
  }): Promise<boolean>;
  /** Source-tree digest of a commit, excluding the `.harness` Ledger content. */
  sourceTreeDigest(commit: string): Promise<string>;
  /** Absolute roots of the disposable candidate worktrees under the managed root. */
  listCandidateWorktrees(): Promise<readonly string[]>;
}

const execFileAsync = promisify(execFile);

async function gitStdout(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
}

const ZERO_OID = "0000000000000000000000000000000000000000";

/**
 * Digest of the project source tree of one commit: the full `ls-tree -r`
 * listing with every `.harness` Ledger entry excluded, so the digest never
 * covers the store that carries the record itself (design §14).
 */
export async function sourceTreeDigest(
  repositoryRoot: string,
  commit: string,
  options?: { readonly excludeHarnessLedger?: boolean },
): Promise<string> {
  const exclude = options?.excludeHarnessLedger ?? true;
  const listing = await gitStdout(repositoryRoot, ["ls-tree", "-r", commit]);
  const lines = listing
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => {
      if (!exclude) return true;
      const path = line.split("\t")[1] ?? "";
      return path !== ".harness" && !path.startsWith(".harness/");
    });
  return contentDigest(lines.join("\n"));
}

export interface GitWaveIntegrationOptions {
  readonly repositoryRoot: string;
  /** Exact managed root; candidate worktrees live under `<managedRoot>/candidates`. */
  readonly managedRoot: string;
  /** Fixed Harness-owned commit identity; agent metadata is never consulted. */
  readonly commitIdentity: { readonly name: string; readonly email: string };
}

export function createGitWaveIntegrationGit(
  options: GitWaveIntegrationOptions,
): WaveIntegrationGitPort {
  const candidatesRoot = join(options.managedRoot, "candidates");
  return {
    async createCandidateWorktree(input) {
      await mkdir(candidatesRoot, { recursive: true });
      const root = await mkdtemp(join(candidatesRoot, `wave-${String(input.wave_index)}-`));
      await gitStdout(options.repositoryRoot, [
        "worktree",
        "add",
        "--detach",
        root,
        input.base_commit,
      ]);
      return root;
    },

    async applyManagedPatch(input) {
      const content = await readFile(input.patch.patch_locator, "utf8");
      if (contentDigest(content) !== input.patch.patch_digest) {
        throw new CandidateIntegrationError(
          "patch_digest_mismatch",
          `patch artifact ${input.patch.patch_locator} digests to ${contentDigest(content)}, ` +
            `not the committed ${input.patch.patch_digest}`,
        );
      }
      try {
        await gitStdout(input.worktree_root, ["apply", "--index", input.patch.patch_locator]);
      } catch (error) {
        throw new CandidateIntegrationError(
          "integration_conflict",
          `patch of task ${input.patch.task_id} does not apply to the candidate tree: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    },

    async commitCandidate(input) {
      await gitStdout(input.worktree_root, [
        "-c",
        `user.name=${options.commitIdentity.name}`,
        "-c",
        `user.email=${options.commitIdentity.email}`,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        input.message,
      ]);
      return (await gitStdout(input.worktree_root, ["rev-parse", "HEAD"])).trim();
    },

    async discardWorktree(root) {
      await gitStdout(options.repositoryRoot, ["worktree", "remove", "--force", root]).catch(
        async () => rm(root, { recursive: true, force: true }),
      );
    },

    async readRef(ref) {
      try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", ref], {
          cwd: options.repositoryRoot,
        });
        const oid = stdout.trim();
        return oid === "" ? undefined : oid;
      } catch {
        return undefined;
      }
    },

    async compareAndSwapRef(input) {
      try {
        await gitStdout(
          options.repositoryRoot,
          input.next === undefined
            ? ["update-ref", "-d", input.ref, input.expected ?? ZERO_OID]
            : ["update-ref", input.ref, input.next, input.expected ?? ZERO_OID],
        );
        return true;
      } catch {
        return false;
      }
    },

    async sourceTreeDigest(commit) {
      return sourceTreeDigest(options.repositoryRoot, commit, { excludeHarnessLedger: true });
    },

    async listCandidateWorktrees() {
      try {
        const entries = await readdir(candidatesRoot, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(candidatesRoot, entry.name))
          .sort();
      } catch {
        return [];
      }
    },
  };
}

// --- Gate port ----------------------------------------------------------------

/**
 * Candidate/wave gate execution. The production wiring (Task 11) builds this
 * over the existing gate suite runner; the controller never trusts the
 * returned records — every one is re-validated for bindings and freshness
 * against the current gate definitions, policy and commit before it counts.
 */
export interface WaveGatePort {
  /** Current gate definitions; each digest is the evidence freshness anchor. */
  definitions(): readonly GateDefinition[];
  /** Layer 2: the task's relevant gates re-run on the current candidate tree. */
  runCandidateGates(input: {
    readonly task: Protocol13TaskSpecification;
    readonly candidate_commit: string;
    readonly lease: TaskLeaseRecord;
    readonly worktree_root?: string;
  }): Promise<readonly GateEvidenceRecord[]>;
  /** Layer 3: project Mandatory Gates run once against the complete candidate. */
  runWaveGates(input: {
    readonly dag: TaskDagSnapshot;
    readonly wave_index: number;
    readonly candidate_commit: string;
    readonly tasks: readonly Protocol13TaskSpecification[];
    readonly leases: readonly TaskLeaseRecord[];
    readonly worktree_root?: string;
  }): Promise<readonly GateEvidenceRecord[]>;
}

// --- Controller interface (plan Task 10 Shared Interfaces) --------------------

export interface RebuildWaveInput {
  readonly dag: TaskDagSnapshot;
  readonly wave: ParallelWave;
  readonly expected_base_commit: string;
}

export interface WaveCandidate {
  readonly wave_index: number;
  readonly base_commit: string;
  readonly candidate_commit: string;
  readonly applied_task_ids: readonly string[];
}

export interface ValidateTaskCandidateInput {
  readonly candidate: WaveCandidate;
  readonly task: Protocol13TaskSpecification;
  readonly lease: TaskLeaseRecord;
  readonly evidence: readonly {
    readonly kind: string;
    readonly locator: string;
    readonly digest: string;
  }[];
}

export interface TaskCandidateValidation {
  readonly task_id: string;
  readonly status: "candidate_validated" | "blocked";
  readonly evidence_digests: readonly string[];
}

/** The M3 Operation Lease the publisher needs in connected mode (design §22). */
export interface WaveOperationLease {
  readonly operation_id: string;
  readonly fencing_token: number;
}

export interface AcceptWaveInput {
  readonly dag: TaskDagSnapshot;
  readonly candidate: WaveCandidate;
  readonly validations: readonly TaskCandidateValidation[];
  readonly policy_decision: PolicyDecision;
  readonly approval_digests: readonly string[];
  readonly command_id: string;
  /**
   * Connected mode (M3): the current Operation Lease. Required exactly when
   * the controller was built with `publish_candidate`; the local branch is
   * published only through the existing publish_operation_candidate path and
   * M4 never writes the remote target branch.
   */
  readonly operation_lease?: WaveOperationLease;
}

export interface CandidateIntegrationController {
  queueTaskCandidate(candidate: TaskCandidatePatch): Promise<void>;
  rebuildWaveCandidate(input: RebuildWaveInput): Promise<WaveCandidate>;
  validateTaskCandidate(input: ValidateTaskCandidateInput): Promise<TaskCandidateValidation>;
  acceptWave(input: AcceptWaveInput): Promise<WaveIntegrationRecord>;
}

export interface CandidateIntegrationControllerOptions {
  readonly authority: SchedulerAuthority;
  readonly git: WaveIntegrationGitPort;
  readonly gates: WaveGatePort;
  readonly effective_policy_digest: string;
  readonly adapter_manifest_digest: string;
  readonly adapter_control_profile: AdapterControlProfile;
  /** Operation-local ref name; defaults to refs/heads/operation/<operation_id>. */
  readonly operation_ref?: (operationId: string) => string;
  /** Fixed commit message input; never derived from agent output. */
  readonly commit_message?: (task: Protocol13TaskSpecification) => string;
  /** ISO clock; injectable so replays are byte-deterministic. */
  readonly now?: () => string;
  /**
   * Connected M3 mode: publishes the accepted local operation branch through
   * the existing publish_operation_candidate command. Absent = unconnected
   * mode, where acceptance stops at the local ref CAS.
   */
  readonly publish_candidate?: (input: {
    readonly operation_id: string;
    readonly candidate_commit: string;
    readonly fencing_token: number;
    readonly command_id: string;
  }) => Promise<
    { readonly status: "published" } | { readonly status: "failed"; readonly reason: string }
  >;
}

/**
 * The exact PolicyDecisionPort input an `integrate_wave` decision must bind
 * (design §11). Exported so the caller that obtains the decision and the
 * controller that re-validates it normalize the identical action.
 */
export function waveIntegrationPolicyInput(input: {
  readonly dag: TaskDagSnapshot;
  readonly wave: ParallelWave;
  readonly base_commit: string;
  readonly leases: readonly TaskLeaseRecord[];
  readonly adapter_manifest_digest: string;
  readonly adapter_control_profile: AdapterControlProfile;
  readonly effective_policy_digest: string;
  readonly now: string;
}): SchedulerPolicyInput {
  const tasks = input.wave.task_ids.map((taskId) => {
    const found = input.dag.tasks.find((candidate) => candidate.id === taskId);
    if (found === undefined) {
      throw new CandidateIntegrationError(
        "wave_base_mismatch",
        `wave ${String(input.wave.wave_index)} names task ${taskId}, which the approved plan does not contain`,
      );
    }
    return found;
  });
  const riskOrder = ["low", "medium", "high", "critical"] as const;
  const risk = tasks.reduce(
    (highest, taskSpec) =>
      riskOrder.indexOf(taskSpec.risk) > riskOrder.indexOf(highest) ? taskSpec.risk : highest,
    "low" as (typeof riskOrder)[number],
  );
  const union = (pick: (taskSpec: Protocol13TaskSpecification) => readonly string[]): string[] =>
    [...new Set(tasks.flatMap(pick))].sort();
  const account = restoreBudgetAccount({
    limit: input.dag.iteration_budget,
    iteration_deadline: deriveIterationDeadline(input.dag, input.leases, input.now),
    records: input.leases,
  });
  const remaining = remainingBudget(account);
  return {
    action: "integrate_wave",
    operation_id: input.dag.operation_id,
    iteration_id: input.dag.iteration_id,
    plan_digest: input.dag.plan_digest,
    wave_index: input.wave.wave_index,
    baseline_commit: input.base_commit,
    risk,
    capabilities: union((taskSpec) => taskSpec.capabilities),
    tools: union((taskSpec) => taskSpec.tools),
    write_paths: union((taskSpec) => taskSpec.write_paths),
    exclusive_resources: union((taskSpec) => taskSpec.exclusive_resources),
    iteration_remaining_budget: {
      steps: remaining.steps,
      tokens: remaining.tokens,
      duration_ms: Math.max(
        0,
        Date.parse(deriveIterationDeadline(input.dag, input.leases, input.now)) -
          Date.parse(input.now),
      ),
    },
    adapter_manifest_digest: input.adapter_manifest_digest,
    adapter_control_profile: input.adapter_control_profile,
    effective_policy_digest: input.effective_policy_digest,
  };
}

function digestId(prefix: string, parts: unknown): string {
  return `${prefix}_${contentDigest(parts).slice(0, 24)}`;
}

function findingRule(finding: FeedbackRecord): string | undefined {
  const extension = finding.extensions?.["harness.finding"];
  if (typeof extension !== "object" || extension === null) return undefined;
  const rule = (extension as { rule?: unknown }).rule;
  return typeof rule === "string" ? rule : undefined;
}

function findingBlocks(finding: FeedbackRecord): readonly string[] {
  const extension = finding.extensions?.["harness.finding"];
  if (typeof extension !== "object" || extension === null) return [];
  const blocks = (extension as { blocks?: unknown }).blocks;
  return Array.isArray(blocks) ? (blocks as string[]) : [];
}

function isOpenFinding(finding: FeedbackRecord): boolean {
  return (
    finding.type === "Finding" && (finding.status === "proposed" || finding.status === "accepted")
  );
}

export function createCandidateIntegrationController(
  options: CandidateIntegrationControllerOptions,
): CandidateIntegrationController {
  const now = options.now ?? (() => new Date().toISOString());
  const { authority, git, gates } = options;
  const refOf = options.operation_ref ?? operationRefFor;
  const commitMessage =
    options.commit_message ??
    ((taskSpec: Protocol13TaskSpecification) => `harness: task ${taskSpec.id} candidate`);
  /** In-memory integration buffer: task_id → latest queued patch. */
  const queue = new Map<string, TaskCandidatePatch>();
  /** Live candidate worktree roots keyed by candidate commit (until accepted/discarded). */
  const candidateRoots = new Map<string, string>();

  const finding = (input: {
    readonly iteration_id: string;
    readonly rule: string;
    readonly blocking: boolean;
    readonly blocks: readonly string[];
    readonly summary: string;
    readonly subject_digests?: readonly string[];
  }): FeedbackRecord => {
    const content = {
      protocol_version: PROTOCOL_1_3_VERSION,
      record_kind: "feedback" as const,
      id: digestId("finding", {
        iteration_id: input.iteration_id,
        rule: input.rule,
        blocks: [...input.blocks],
      }),
      type: "Finding" as const,
      iteration_id: input.iteration_id,
      status: "proposed" as const,
      summary: input.summary,
      created_at: now(),
      extensions: {
        "harness.finding": {
          origin: "scheduler",
          blocking: input.blocking,
          violates: [],
          blocks: [...input.blocks],
          evidence: [],
          rule: input.rule,
          severity: "error",
          actionability: "human_review",
          subject_ids: [...input.blocks],
          subject_digests: [...(input.subject_digests ?? [])],
        },
      },
    };
    return { ...content, digest: contentDigest(content) };
  };

  const currentGateDigest = (gateId: string): string | undefined =>
    gates.definitions().find((definition) => definition.gate_id === gateId)?.digest;

  /**
   * Full binding + freshness revalidation of one evidence record. Every
   * freshness field is compared against current authoritative values; any
   * mutation of the actual commit, Plan/Task digest, Run, Lease fencing token
   * or gate definition digest rejects here (design §13.2/§17).
   */
  const assertEvidenceValid = (
    record: GateEvidenceRecord,
    expected: {
      readonly layer: SchedulingEvidenceBinding["layer"];
      readonly commit: string;
      readonly plan_digest: string;
      readonly lease?: TaskLeaseRecord;
      readonly task?: Protocol13TaskSpecification;
    },
  ): void => {
    if (record.provisional) {
      throw new CandidateIntegrationError(
        "evidence_binding_mismatch",
        `evidence ${record.evidence_id} is provisional and never satisfies integration`,
      );
    }
    const gate = readGateEvidenceExtension(record);
    if (gate === undefined || !gate.passed) {
      throw new CandidateIntegrationError(
        "evidence_binding_mismatch",
        `evidence ${record.evidence_id} is not a passed gate verdict`,
      );
    }
    const binding = schedulingEvidenceBindingOf(record);
    if (binding === undefined || binding.layer !== expected.layer) {
      throw new CandidateIntegrationError(
        "evidence_binding_mismatch",
        `evidence ${record.evidence_id} lacks the ${expected.layer} scheduling binding`,
      );
    }
    if (binding.commit !== expected.commit) {
      throw new CandidateIntegrationError(
        "evidence_binding_mismatch",
        `evidence ${record.evidence_id} binds commit ${binding.commit}, not ${expected.commit}`,
      );
    }
    if (binding.plan_digest !== expected.plan_digest) {
      throw new CandidateIntegrationError(
        "evidence_binding_mismatch",
        `evidence ${record.evidence_id} binds plan ${binding.plan_digest}, not ${expected.plan_digest}`,
      );
    }
    if (expected.lease !== undefined && expected.task !== undefined) {
      const lease = expected.lease;
      if (
        binding.task_id !== expected.task.id ||
        binding.task_digest !== taskSemanticDigest(expected.task) ||
        binding.task_digest !== lease.task_digest ||
        binding.run_id !== lease.run_id ||
        binding.lease_id !== lease.lease_id ||
        binding.fencing_token !== lease.fencing_token
      ) {
        throw new CandidateIntegrationError(
          "evidence_binding_mismatch",
          `evidence ${record.evidence_id} does not bind task ${expected.task.id}, run ` +
            `${lease.run_id} and fencing token ${String(lease.fencing_token)} of the current lease`,
        );
      }
    }
    const definitionDigest = currentGateDigest(gate.gate_id);
    if (definitionDigest === undefined) {
      throw new CandidateIntegrationError(
        "evidence_stale",
        `gate ${gate.gate_id} has no current definition; evidence ${record.evidence_id} can never be fresh`,
      );
    }
    const staleness = evidenceStalenessReasons(record, {
      // Artifact/evaluation-case digests are Ledger-vouched content bindings
      // with no tree addressing here; code, gate and policy re-verify exactly.
      artifact_digests: gate.bindings.artifact_digests,
      code_digests: [expected.commit],
      gate_digest: definitionDigest,
      evaluation_case_digests: gate.bindings.evaluation_case_digests,
      policy_digest: options.effective_policy_digest,
    });
    if (staleness.length > 0) {
      throw new CandidateIntegrationError(
        "evidence_stale",
        `evidence ${record.evidence_id} is stale: ${staleness.join(", ")}`,
      );
    }
  };

  /** The wave's authoritative frozen base (design §13.3): the plan baseline for
   * wave 0, else the accepted candidate commit of the previous wave. */
  const waveBase = (
    dag: TaskDagSnapshot,
    facts: { readonly wave_integrations: readonly WaveIntegrationRecord[] },
    waveIndex: number,
  ): string => {
    if (waveIndex === 0) return dag.baseline_commit;
    const previous = facts.wave_integrations.find(
      (record) => record.operation_id === dag.operation_id && record.wave_index === waveIndex - 1,
    );
    if (previous === undefined) {
      throw new CandidateIntegrationError(
        "wave_base_mismatch",
        `wave ${String(waveIndex)} cannot rebuild: wave ${String(waveIndex - 1)} is not integrated`,
      );
    }
    if (previous.plan_digest !== dag.plan_digest) {
      throw new CandidateIntegrationError(
        "wave_base_mismatch",
        `wave ${String(waveIndex - 1)} integrated under plan ${previous.plan_digest}, ` +
          `not the approved ${dag.plan_digest}`,
      );
    }
    return previous.candidate_commit;
  };

  /** The operation-local ref must still equal the wave base; any drift is
   * baseline_drift and never consumes the integration retry (design §13.4). */
  const assertRefAtBase = async (
    dag: TaskDagSnapshot,
    waveIndex: number,
    base: string,
  ): Promise<string | undefined> => {
    const current = await git.readRef(refOf(dag.operation_id));
    if (current !== undefined && current !== base) {
      throw new CandidateIntegrationError(
        "baseline_drift",
        `operation ref holds ${current}, not the wave base ${base}; no force, no blind replay`,
      );
    }
    if (current === undefined && waveIndex > 0) {
      throw new CandidateIntegrationError(
        "baseline_drift",
        `operation ref is missing although wave ${String(waveIndex - 1)} was accepted at ${base}`,
      );
    }
    return current;
  };

  /** First apply failure schedules the single integration_retry; a second
   * failure of the same class blocks the Task (design §15.1). */
  const noteIntegrationConflict = async (
    dag: TaskDagSnapshot,
    taskId: string,
    cause: unknown,
  ): Promise<never> => {
    const facts = await authority.readFacts(dag.operation_id);
    const chain = buildTaskLeaseChain(facts.leases);
    const consumed =
      chain.records.some(
        (record) => record.task_id === taskId && record.retry_kind === "integration_retry",
      ) ||
      facts.findings.some(
        (entry) =>
          isOpenFinding(entry) &&
          findingRule(entry) === "integration_retry_scheduled" &&
          findingBlocks(entry).includes(taskId),
      );
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!consumed) {
      const latest = chain.latest_by_task.get(taskId);
      await authority.commit([
        {
          kind: "append_event",
          event: taskRetryScheduledEvent({
            operation_id: dag.operation_id,
            task_id: taskId,
            retry_kind: "integration_retry",
            attempt_number: (latest?.attempt_number ?? 0) + 1,
            reason: `task patch does not apply to the candidate tree: ${message}`,
          }),
        },
        {
          kind: "create_finding",
          finding: finding({
            iteration_id: dag.iteration_id,
            rule: "integration_retry_scheduled",
            blocking: false,
            blocks: [taskId],
            summary:
              `task ${taskId} patch failed to apply to the candidate tree; the single ` +
              "integration retry is scheduled on the latest integrated commit",
          }),
        },
      ]);
    } else {
      await authority.commit([
        {
          kind: "create_finding",
          finding: finding({
            iteration_id: dag.iteration_id,
            rule: "integration_conflict",
            blocking: true,
            blocks: [taskId],
            summary:
              `task ${taskId} patch failed to apply a second time; the integration retry ` +
              "is exhausted and the Task is blocked",
          }),
        },
      ]);
    }
    throw new CandidateIntegrationError(
      "integration_conflict",
      `task ${taskId} patch does not apply to the candidate tree: ${message}`,
    );
  };

  return {
    async queueTaskCandidate(candidate) {
      if (
        candidate.task_id === "" ||
        candidate.patch_locator === "" ||
        !/^[a-f0-9]{64}$/u.test(candidate.patch_digest)
      ) {
        throw new CandidateIntegrationError(
          "missing_candidate",
          `candidate patch of task ${candidate.task_id} is structurally incomplete`,
        );
      }
      const existing = queue.get(candidate.task_id);
      if (existing !== undefined && existing.patch_digest === candidate.patch_digest) return;
      // A re-executed attempt replaces the unintegrated queued patch.
      queue.set(candidate.task_id, candidate);
    },

    async rebuildWaveCandidate(input) {
      const { dag, wave } = input;
      const facts = await authority.readFacts(dag.operation_id);
      const approved = dag.parallel_waves.find(
        (candidateWave) => candidateWave.wave_index === wave.wave_index,
      );
      if (approved === undefined) {
        throw new CandidateIntegrationError(
          "wave_base_mismatch",
          `wave ${String(wave.wave_index)} is not part of the approved plan`,
        );
      }
      const base = waveBase(dag, facts, approved.wave_index);
      if (input.expected_base_commit !== base) {
        throw new CandidateIntegrationError(
          "wave_base_mismatch",
          `wave ${String(wave.wave_index)} base is ${base}, not the expected ${input.expected_base_commit}`,
        );
      }
      await assertRefAtBase(dag, approved.wave_index, base);
      for (const taskId of approved.task_ids) {
        if (!queue.has(taskId)) {
          throw new CandidateIntegrationError(
            "missing_candidate",
            `task ${taskId} of wave ${String(wave.wave_index)} has no queued candidate patch`,
          );
        }
      }

      const root = await git.createCandidateWorktree({
        base_commit: base,
        wave_index: approved.wave_index,
      });
      const applied: string[] = [];
      let candidateCommit = base;
      try {
        // Plan order, never completion order (design §13.3).
        for (const taskId of approved.task_ids) {
          const patch = queue.get(taskId) as TaskCandidatePatch;
          const taskSpec = dag.tasks.find(
            (candidateTask) => candidateTask.id === taskId,
          ) as Protocol13TaskSpecification;
          try {
            await git.applyManagedPatch({ worktree_root: root, patch });
          } catch (error) {
            if (
              error instanceof CandidateIntegrationError &&
              error.kind === "patch_digest_mismatch"
            ) {
              throw error;
            }
            await noteIntegrationConflict(dag, taskId, error);
          }
          applied.push(taskId);
          candidateCommit = await git.commitCandidate({
            worktree_root: root,
            task_id: taskId,
            message: commitMessage(taskSpec),
          });
        }
      } catch (error) {
        await git.discardWorktree(root).catch(() => undefined);
        throw error;
      }
      candidateRoots.set(candidateCommit, root);
      return {
        wave_index: approved.wave_index,
        base_commit: base,
        candidate_commit: candidateCommit,
        applied_task_ids: applied,
      };
    },

    async validateTaskCandidate(input) {
      const { candidate, task: taskSpec, lease } = input;
      const facts = await authority.readFacts(lease.operation_id);
      const chain = buildTaskLeaseChain(facts.leases);
      const latest = chain.latest_by_task.get(taskSpec.id);
      if (
        latest === undefined ||
        latest.fencing_token !== lease.fencing_token ||
        latest.record_digest !== lease.record_digest
      ) {
        throw new CandidateIntegrationError(
          "lease_not_current",
          `lease ${lease.lease_id} (token ${String(lease.fencing_token)}) is not the current ` +
            `lease of task ${taskSpec.id}`,
        );
      }
      if (lease.state !== "granted") {
        throw new CandidateIntegrationError(
          "lease_not_released",
          `lease ${lease.lease_id} is ${lease.state}; candidate validation requires the current ` +
            "granted Lease and releases it only in the successful validation transaction",
        );
      }
      if (lease.task_id !== taskSpec.id || lease.task_digest !== taskSemanticDigest(taskSpec)) {
        throw new CandidateIntegrationError(
          "evidence_binding_mismatch",
          `lease ${lease.lease_id} does not bind the approved specification of task ${taskSpec.id}`,
        );
      }
      if (!candidate.applied_task_ids.includes(taskSpec.id)) {
        throw new CandidateIntegrationError(
          "task_not_in_wave",
          `candidate ${candidate.candidate_commit} does not contain task ${taskSpec.id}`,
        );
      }
      // Recheck undeclared writes against the approved write set (design §12).
      const queued = queue.get(taskSpec.id);
      if (queued !== undefined) {
        const outside = queued.changed_paths.filter(
          (path) => !isPathWithinScopes([...taskSpec.write_paths], path),
        );
        if (outside.length > 0) {
          await authority.commit([
            {
              kind: "create_finding",
              finding: finding({
                iteration_id: lease.iteration_id,
                rule: "undeclared_write",
                blocking: true,
                blocks: [taskSpec.id],
                summary:
                  `task ${taskSpec.id} candidate writes outside the declared write set: ` +
                  outside.join(", "),
              }),
            },
          ]);
          throw new CandidateIntegrationError(
            "undeclared_write",
            `task ${taskSpec.id} candidate writes outside the declared write set: ${outside.join(", ")}`,
          );
        }
      }

      // Layer 1: task workspace evidence, resolved from authoritative facts and
      // re-validated field by field.
      const taskEvidence = input.evidence.map((ref) => {
        const record = facts.gate_evidence.find(
          (candidateRecord) => candidateRecord.digest === ref.digest,
        );
        if (record === undefined) {
          throw new CandidateIntegrationError(
            "evidence_binding_mismatch",
            `evidence digest ${ref.digest} is not an authoritative fact of operation ${lease.operation_id}`,
          );
        }
        return record;
      });
      for (const record of taskEvidence) {
        assertEvidenceValid(record, {
          layer: "task",
          commit: lease.baseline_commit,
          plan_digest: lease.plan_digest,
          lease,
          task: taskSpec,
        });
      }
      for (const gateId of taskSpec.required_gates) {
        const definition = gates.definitions().find((candidate) => candidate.gate_id === gateId);
        if (definition === undefined) {
          throw new CandidateIntegrationError(
            "evidence_stale",
            `required gate ${gateId} has no current definition`,
          );
        }
        const matches = taskEvidence.filter(
          (record) => readGateEvidenceExtension(record)?.gate_id === gateId,
        );
        if (matches.length !== 1) {
          throw new CandidateIntegrationError(
            "evidence_binding_mismatch",
            `required gate ${gateId} has ${String(matches.length)} fresh Task Evidence records`,
          );
        }
      }

      // Layer 2: the task's relevant gates re-run on the current candidate tree.
      const candidateEvidence = await gates.runCandidateGates({
        task: taskSpec,
        candidate_commit: candidate.candidate_commit,
        lease,
        ...(candidateRoots.get(candidate.candidate_commit) === undefined
          ? {}
          : { worktree_root: candidateRoots.get(candidate.candidate_commit) as string }),
      });
      const digests = [
        ...taskEvidence.map((record) => record.digest),
        ...candidateEvidence.map((record) => record.digest),
      ];
      let gateFailure: string | undefined;
      const requiredCandidateGateIds =
        taskSpec.required_gates.length === 0
          ? gates.definitions().map((definition) => definition.gate_id)
          : [...taskSpec.required_gates];
      for (const gateId of requiredCandidateGateIds) {
        if (!gates.definitions().some((definition) => definition.gate_id === gateId)) {
          gateFailure = `required candidate gate ${gateId} has no current definition`;
          break;
        }
        const matches = candidateEvidence.filter(
          (record) => readGateEvidenceExtension(record)?.gate_id === gateId,
        );
        if (matches.length !== 1) {
          gateFailure = `required candidate gate ${gateId} produced ${String(matches.length)} Evidence records`;
          break;
        }
      }
      for (const record of candidateEvidence) {
        if (gateFailure !== undefined) break;
        try {
          assertEvidenceValid(record, {
            layer: "candidate",
            commit: candidate.candidate_commit,
            plan_digest: lease.plan_digest,
            lease,
            task: taskSpec,
          });
        } catch (error) {
          gateFailure = error instanceof Error ? error.message : String(error);
          break;
        }
      }
      if (gateFailure !== undefined) {
        // A clean textual apply that fails a candidate gate is a semantic
        // conflict: it never consumes the integration retry (design §13.4).
        await authority.commit([
          { kind: "append_gate_evidence", records: candidateEvidence },
          {
            kind: "create_finding",
            finding: finding({
              iteration_id: lease.iteration_id,
              rule: "candidate_gate_failed",
              blocking: true,
              blocks: [taskSpec.id],
              summary: `task ${taskSpec.id} candidate gate failed on the candidate tree: ${gateFailure}`,
            }),
          },
        ]);
        return { task_id: taskSpec.id, status: "blocked", evidence_digests: digests };
      }

      const terminalRun = facts.runs.find(
        (record) => record.run_id === lease.run_id && record.record_kind === "run_terminated",
      );
      const usage = terminalRun?.extensions?.["harness.scheduler"] as
        | { readonly consumed_budget?: { readonly steps?: unknown; readonly tokens?: unknown } }
        | undefined;
      const steps = usage?.consumed_budget?.steps;
      const tokens = usage?.consumed_budget?.tokens;
      if (
        typeof steps !== "number" ||
        !Number.isInteger(steps) ||
        steps < 0 ||
        steps > lease.reserved_budget.steps ||
        typeof tokens !== "number" ||
        !Number.isInteger(tokens) ||
        tokens < 0 ||
        tokens > lease.reserved_budget.tokens
      ) {
        throw new CandidateIntegrationError(
          "evidence_binding_mismatch",
          `run ${lease.run_id} has no valid authoritative consumed-budget observation`,
        );
      }

      await authority.commit([
        { kind: "append_gate_evidence", records: candidateEvidence },
        {
          kind: "terminate_lease",
          record: terminateTaskLease(lease, {
            state: "released",
            consumed_budget: { steps, tokens },
            command_id: digestId("command", {
              purpose: "candidate-validated-release",
              operation_id: lease.operation_id,
              task_id: taskSpec.id,
              run_id: lease.run_id,
              fencing_token: lease.fencing_token,
              candidate_commit: candidate.candidate_commit,
            }),
          }),
        },
        {
          kind: "append_event",
          event: taskCandidateValidatedEvent({
            operation_id: lease.operation_id,
            task_id: taskSpec.id,
            evidence_digests: digests,
          }),
        },
      ]);
      return { task_id: taskSpec.id, status: "candidate_validated", evidence_digests: digests };
    },

    async acceptWave(input) {
      const { dag, candidate, validations, command_id } = input;
      const facts = await authority.readFacts(dag.operation_id);
      const ref = refOf(dag.operation_id);

      // command_id replay: discover the accepted record instead of advancing
      // twice; complete a lost ref move when the CAS response was lost.
      const existing = facts.wave_integrations.find((record) => record.command_id === command_id);
      if (existing !== undefined) {
        if (
          existing.wave_index !== candidate.wave_index ||
          existing.candidate_commit !== candidate.candidate_commit ||
          existing.base_commit !== candidate.base_commit ||
          existing.plan_digest !== dag.plan_digest
        ) {
          throw new CandidateIntegrationError(
            "command_conflict",
            `command ${command_id} accepted wave ${String(existing.wave_index)} at ` +
              `${existing.candidate_commit}; a replay with different content is a conflict`,
          );
        }
        const current = await git.readRef(ref);
        if (current === existing.candidate_commit) return existing;
        if (current === existing.base_commit || current === undefined) {
          const moved = await git.compareAndSwapRef({
            ref,
            expected: current,
            next: existing.candidate_commit,
          });
          if (moved) return existing;
        }
        throw new CandidateIntegrationError(
          "baseline_drift",
          `command ${command_id} is accepted in the Ledger but the operation ref holds ` +
            `${String(current)}; manual reconciliation required`,
        );
      }

      const wave = dag.parallel_waves.find(
        (candidateWave) => candidateWave.wave_index === candidate.wave_index,
      );
      if (wave === undefined) {
        throw new CandidateIntegrationError(
          "wave_base_mismatch",
          `wave ${String(candidate.wave_index)} is not part of the approved plan`,
        );
      }
      const base = waveBase(dag, facts, wave.wave_index);
      if (candidate.base_commit !== base) {
        throw new CandidateIntegrationError(
          "baseline_drift",
          `candidate base ${candidate.base_commit} is not the authoritative wave base ${base}`,
        );
      }
      if (
        candidate.applied_task_ids.length !== wave.task_ids.length ||
        !candidate.applied_task_ids.every((taskId, index) => taskId === wave.task_ids[index])
      ) {
        throw new CandidateIntegrationError(
          "candidate_not_validated",
          `candidate ${candidate.candidate_commit} does not apply exactly the wave tasks in Plan order`,
        );
      }

      // Every wave Task: a candidate_validated validation plus a current,
      // released lease with fresh candidate-layer evidence (design §13.3).
      const chain = buildTaskLeaseChain(facts.leases);
      const latestLeases: TaskLeaseRecord[] = [];
      const taskEvidenceDigests = new Set<string>();
      const candidateEvidenceDigests = new Set<string>();
      for (const taskId of wave.task_ids) {
        const validation = validations.find(
          (entry) => entry.task_id === taskId && entry.status === "candidate_validated",
        );
        if (validation === undefined) {
          throw new CandidateIntegrationError(
            "candidate_not_validated",
            `task ${taskId} has no candidate_validated validation`,
          );
        }
        const latest = chain.latest_by_task.get(taskId);
        if (latest === undefined) {
          throw new CandidateIntegrationError("lease_not_current", `task ${taskId} has no lease`);
        }
        if (latest.state !== "released") {
          // A newer attempt (granted or terminal) supersedes the validated
          // lease: the validated fencing token is stale, which is the precise
          // rejection (design §8.2/§13.2).
          const validatedToken = validations
            .find((entry) => entry.task_id === taskId)
            ?.evidence_digests.map((digest) =>
              facts.gate_evidence.find((record) => record.digest === digest),
            )
            .map((record) =>
              record === undefined ? undefined : schedulingEvidenceBindingOf(record)?.fencing_token,
            )
            .find((token) => token !== undefined);
          if (validatedToken !== undefined && validatedToken !== latest.fencing_token) {
            throw new CandidateIntegrationError(
              "lease_not_current",
              `task ${taskId} validated under fencing token ${String(validatedToken)}, but ` +
                `the current lease holds token ${String(latest.fencing_token)}`,
            );
          }
          throw new CandidateIntegrationError(
            "lease_not_released",
            `task ${taskId} current lease ${latest.lease_id} is ${latest.state}, not released`,
          );
        }
        const taskSpec = dag.tasks.find(
          (candidateTask) => candidateTask.id === taskId,
        ) as Protocol13TaskSpecification;
        const records = validation.evidence_digests.map((digest) => {
          const record = facts.gate_evidence.find(
            (candidateRecord) => candidateRecord.digest === digest,
          );
          if (record === undefined) {
            throw new CandidateIntegrationError(
              "evidence_binding_mismatch",
              `validation of task ${taskId} names evidence ${digest}, which is not authoritative`,
            );
          }
          return record;
        });
        let sawCandidateLayer = false;
        for (const record of records) {
          const layer = schedulingEvidenceBindingOf(record)?.layer;
          if (layer === "task") {
            assertEvidenceValid(record, {
              layer: "task",
              commit: latest.baseline_commit,
              plan_digest: dag.plan_digest,
              lease: latest,
              task: taskSpec,
            });
            taskEvidenceDigests.add(record.digest);
          } else if (layer === "candidate") {
            assertEvidenceValid(record, {
              layer: "candidate",
              commit: candidate.candidate_commit,
              plan_digest: dag.plan_digest,
              lease: latest,
              task: taskSpec,
            });
            candidateEvidenceDigests.add(record.digest);
            sawCandidateLayer = true;
          }
        }
        if (!sawCandidateLayer) {
          throw new CandidateIntegrationError(
            "candidate_not_validated",
            `task ${taskId} carries no candidate-layer gate evidence bound to ${candidate.candidate_commit}`,
          );
        }
        latestLeases.push(latest);
      }

      // Policy/Approval: the decision must bind the exact integrate_wave
      // action normalized from current facts and the pinned effective policy.
      const decision = input.policy_decision;
      if (decision.effective_policy_digest !== options.effective_policy_digest) {
        throw new CandidateIntegrationError(
          "policy_not_allowed",
          `decision binds policy ${decision.effective_policy_digest}, not the current ` +
            options.effective_policy_digest,
        );
      }
      const expectedActionDigest = actionDigest(
        schedulerPolicyAction(
          waveIntegrationPolicyInput({
            dag,
            wave,
            base_commit: candidate.base_commit,
            leases: facts.leases,
            adapter_manifest_digest: options.adapter_manifest_digest,
            adapter_control_profile: options.adapter_control_profile,
            effective_policy_digest: options.effective_policy_digest,
            now: now(),
          }),
        ),
      );
      if (decision.action_digest !== expectedActionDigest) {
        throw new CandidateIntegrationError(
          "policy_not_allowed",
          `decision binds action ${decision.action_digest}, not the current integrate_wave ` +
            `action ${expectedActionDigest}`,
        );
      }
      if (decision.outcome === "deny" || decision.outcome === "block") {
        throw new CandidateIntegrationError(
          "policy_not_allowed",
          `policy ${decision.outcome} never accepts a wave: ${decision.reasons.join("; ")}`,
        );
      }
      if (decision.outcome === "requires_approval") {
        if (
          decision.approval_digest === undefined ||
          !input.approval_digests.includes(decision.approval_digest)
        ) {
          throw new CandidateIntegrationError(
            "approval_not_satisfied",
            "a requires_approval decision accepts a wave only with the satisfying approval digest",
          );
        }
      }

      // Layer 3: wave Mandatory Gates on the complete candidate. Failure keeps
      // the ref unchanged and never moves Tasks back to retry_pending.
      const tasks = wave.task_ids.map(
        (taskId) =>
          dag.tasks.find(
            (candidateTask) => candidateTask.id === taskId,
          ) as Protocol13TaskSpecification,
      );
      const waveEvidence = await gates.runWaveGates({
        dag,
        wave_index: wave.wave_index,
        candidate_commit: candidate.candidate_commit,
        tasks,
        leases: latestLeases,
        ...(candidateRoots.get(candidate.candidate_commit) === undefined
          ? {}
          : { worktree_root: candidateRoots.get(candidate.candidate_commit) as string }),
      });
      let waveFailure: string | undefined;
      for (const definition of gates.definitions()) {
        if (!definition.mandatory) continue;
        const record = waveEvidence.find(
          (candidateRecord) =>
            readGateEvidenceExtension(candidateRecord)?.gate_id === definition.gate_id,
        );
        if (record === undefined) {
          waveFailure = `mandatory gate ${definition.gate_id} produced no evidence`;
          break;
        }
        try {
          assertEvidenceValid(record, {
            layer: "wave",
            commit: candidate.candidate_commit,
            plan_digest: dag.plan_digest,
          });
        } catch (error) {
          waveFailure = error instanceof Error ? error.message : String(error);
          break;
        }
      }
      const waveDigests = waveEvidence.map((record) => record.digest);
      if (waveFailure !== undefined) {
        await authority.commit([
          { kind: "append_gate_evidence", records: waveEvidence },
          {
            kind: "append_event",
            event: waveGateCompletedEvent({
              operation_id: dag.operation_id,
              wave_index: wave.wave_index,
              passed: false,
              evidence_digests: waveDigests,
            }),
          },
          {
            kind: "create_finding",
            finding: finding({
              iteration_id: dag.iteration_id,
              rule: "wave_gate_failed",
              blocking: true,
              blocks: [],
              summary:
                `wave ${String(wave.wave_index)} mandatory gates failed on candidate ` +
                `${candidate.candidate_commit}: ${waveFailure}; the operation-local ref is ` +
                "unchanged and the failure routes to feedback/impact/plan revision",
              subject_digests: [dag.plan_digest],
            }),
          },
        ]);
        throw new CandidateIntegrationError("wave_gate_failed", waveFailure);
      }

      // Final freshness passed; revalidate the expected base OID immediately
      // before the staged commit (design §13.4).
      const currentRef = await git.readRef(ref);
      const refAlreadyAtCandidate = currentRef === candidate.candidate_commit;
      if (
        !refAlreadyAtCandidate &&
        ((currentRef !== undefined && currentRef !== candidate.base_commit) ||
          (currentRef === undefined &&
            !(wave.wave_index === 0 && candidate.base_commit === dag.baseline_commit)))
      ) {
        await authority.commit([
          {
            kind: "create_finding",
            finding: finding({
              iteration_id: dag.iteration_id,
              rule: "baseline_drift",
              blocking: true,
              blocks: [],
              summary:
                `operation ref drifted from wave base ${candidate.base_commit} to ` +
                `${String(currentRef)} before acceptance; no force, no retry — the wave ` +
                "returns to impact/plan reconfirmation",
              subject_digests: [dag.plan_digest],
            }),
          },
        ]);
        throw new CandidateIntegrationError(
          "baseline_drift",
          `operation ref holds ${String(currentRef)}, not the wave base ${candidate.base_commit}`,
        );
      }

      const record = buildWaveIntegrationRecord({
        wave_integration_id: digestId("wave-integration", {
          operation_id: dag.operation_id,
          plan_digest: dag.plan_digest,
          wave_index: wave.wave_index,
          command_id,
        }),
        operation_id: dag.operation_id,
        iteration_id: dag.iteration_id,
        plan_digest: dag.plan_digest,
        wave_index: wave.wave_index,
        task_ids: [...wave.task_ids],
        base_commit: candidate.base_commit,
        candidate_commit: candidate.candidate_commit,
        accepted_source_tree_digest: await git.sourceTreeDigest(candidate.candidate_commit),
        task_lease_digests: latestLeases.map((lease) => lease.record_digest),
        task_evidence_digests: [...taskEvidenceDigests].sort(),
        candidate_gate_evidence_digests: [...candidateEvidenceDigests].sort(),
        wave_gate_evidence_digests: [...waveDigests].sort(),
        policy_digest: decision.effective_policy_digest,
        approval_digests: [...new Set(input.approval_digests)].sort(),
        command_id,
        integrated_at: now(),
      });

      // Acceptance is recoverable across the Git/Ledger boundary. A fresh
      // command advances the operation-local ref first; a retry that observes
      // the exact candidate there completes a previously lost CAS response.
      // The Ledger batch then seals Evidence + WaveIntegration atomically. If
      // that batch fails in-process, the exact CAS is reversed. A process
      // death after CAS is recovered by the same command on restart — never
      // by accepting a different candidate or force-moving a ref.
      if (!refAlreadyAtCandidate) {
        let moved = false;
        try {
          moved = await git.compareAndSwapRef({
            ref,
            expected: currentRef,
            next: candidate.candidate_commit,
          });
        } catch (error) {
          // An external Git implementation may report an uncertain result.
          // Persist nothing here: replay proves the ref before sealing Ledger.
          throw error;
        }
        if (!moved) {
          const observed = await git.readRef(ref);
          if (observed === candidate.candidate_commit) {
            // Lost-success response: continue to the one Ledger transaction.
            moved = true;
          }
        }
        if (!moved) {
          await authority.commit([
            {
              kind: "create_finding",
              finding: finding({
                iteration_id: dag.iteration_id,
                rule: "baseline_drift",
                blocking: true,
                blocks: [],
                summary:
                  `operation ref CAS lost the race for wave base ${candidate.base_commit}; ` +
                  "neither the ref nor the WaveIntegration authority advanced",
                subject_digests: [dag.plan_digest],
              }),
            },
          ]);
          throw new CandidateIntegrationError(
            "ref_cas_failed",
            `operation ref compare-and-swap failed for ${ref}`,
          );
        }
      }

      try {
        await authority.commit([
          { kind: "append_gate_evidence", records: waveEvidence },
          { kind: "record_wave_integration", record },
          {
            kind: "append_event",
            event: waveGateCompletedEvent({
              operation_id: dag.operation_id,
              wave_index: wave.wave_index,
              passed: true,
              evidence_digests: waveDigests,
            }),
          },
          {
            kind: "append_event",
            event: waveIntegratedEvent({
              operation_id: dag.operation_id,
              wave_index: wave.wave_index,
              task_ids: [...wave.task_ids],
              wave_integration_id: record.wave_integration_id,
              candidate_commit: candidate.candidate_commit,
            }),
          },
        ]);
      } catch (error) {
        const rolledBack = await git.compareAndSwapRef({
          ref,
          expected: candidate.candidate_commit,
          next: currentRef,
        });
        if (!rolledBack) {
          throw new CandidateIntegrationError(
            "ref_cas_failed",
            `Ledger acceptance failed and ${ref} could not be restored from ` +
              `${candidate.candidate_commit} to ${String(currentRef)}: ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
        }
        throw error;
      }

      if ((await git.readRef(ref)) !== candidate.candidate_commit) {
        // The driver lock should make this unreachable. Fail closed rather
        // than returning a false success if an external writer violated it.
        await authority.commit([
          {
            kind: "create_finding",
            finding: finding({
              iteration_id: dag.iteration_id,
              rule: "baseline_drift",
              blocking: true,
              blocks: [],
              summary:
                `operation ref moved after wave ${String(wave.wave_index)} acceptance; ` +
                `record ${record.wave_integration_id} requires manual reconciliation`,
              subject_digests: [dag.plan_digest],
            }),
          },
        ]);
        throw new CandidateIntegrationError(
          "ref_cas_failed",
          `operation ref no longer holds accepted candidate ${candidate.candidate_commit}`,
        );
      }
      const root = candidateRoots.get(candidate.candidate_commit);
      if (root !== undefined) {
        candidateRoots.delete(candidate.candidate_commit);
        await git.discardWorktree(root).catch(() => undefined);
      }

      // Connected M3 mode: publish the accepted local branch through the
      // existing publish_operation_candidate path; M4 never writes the
      // remote target branch (design §22).
      if (options.publish_candidate !== undefined) {
        const lease = input.operation_lease;
        if (lease === undefined || lease.operation_id !== dag.operation_id) {
          throw new CandidateIntegrationError(
            "operation_lease_required",
            "connected mode requires the current M3 Operation Lease to publish the candidate",
          );
        }
        const published = await options.publish_candidate({
          operation_id: dag.operation_id,
          candidate_commit: candidate.candidate_commit,
          fencing_token: lease.fencing_token,
          command_id,
        });
        if (published.status !== "published") {
          throw new CandidateIntegrationError(
            "publish_failed",
            `publish_operation_candidate failed: ${published.reason}`,
          );
        }
      }
      return record;
    },
  };
}
