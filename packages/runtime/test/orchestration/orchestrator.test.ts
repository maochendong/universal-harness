import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { materializeLedger, pageEdges } from "@universal-harness-internal/graph";
import type { AgentRunResult, AgentTaskEnvelope } from "@universal-harness-internal/plugin-sdk";

import {
  OrchestrationError,
  assertLifecycleOrder,
  collectProjectStatus,
  createDefaultEvaluationPort,
  createGenericInterpreter,
  createNewProject,
  findOpenWorkflowOperation,
  normalizeGateDefinition,
  readApprovalRequests,
  readLatestSnapshot,
  resolveApproval,
  resumeIteration,
  runIteration,
  ToolRegistry,
  type ApprovalPrompter,
  type EvaluationPort,
  type GateDefinition,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
} from "../../src/index.js";
import {
  harnessRootFor,
  LedgerRepository,
  readCommittedOperations,
  type EdgeRecord,
} from "../../../core/src/index.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  git,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

/**
 * Phase orchestrator tests (plan Task 23): the same pipeline drives every
 * entry command, pauses only at mandatory approval points, and resumes
 * without duplicating requests, runs, evidence or side effects.
 */
afterEach(cleanupDirectories);

const INTENT = "add the first capability";

interface FakeExecutor {
  readonly calls: readonly AgentTaskEnvelope[];
  readonly executor: (envelope: AgentTaskEnvelope) => Promise<AgentRunResult>;
}

function claimedResult(envelope: AgentTaskEnvelope, note: string): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: `completed ${envelope.task_id} (${note})`,
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      duration_ms: 0,
      metering: "unmetered",
    },
    evidence: [
      {
        kind: "attestation",
        locator: `envelope://${envelope.task_id}`,
        digest: "a".repeat(64),
      },
    ],
    undeclared_writes: [],
  };
}

function recordingExecutor(
  behavior?: (envelope: AgentTaskEnvelope, call: number) => AgentRunResult,
): FakeExecutor {
  const calls: AgentTaskEnvelope[] = [];
  return {
    calls,
    executor: (envelope) => {
      calls.push(envelope);
      const result =
        behavior === undefined
          ? claimedResult(envelope, "default")
          : behavior(envelope, calls.length);
      return Promise.resolve(result);
    },
  };
}

async function bootstrapProject(name: string, newId: (kind: string) => string): Promise<string> {
  const outcome = await createNewProject(
    { parentDirectory: makeTempDir("harness-orch-new-"), name, intent: INTENT },
    {
      vcs: createGitVcsAdapter(),
      now: () => FIXED_NOW,
      // One shared mint per test: bootstrap and orchestration ids live in the
      // same ledger and must never collide.
      newId: (kind) => newId(kind),
    },
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.value.projectRoot;
}

function makeDeps(
  projectRoot: string,
  newId: (kind: string) => string,
  overrides?: Partial<OrchestratorDependencies>,
): OrchestratorDependencies {
  return {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
    vcs: createGitVcsAdapter(),
    interpret: createGenericInterpreter(),
    ...overrides,
  };
}

function approvalRequestsFor(projectRoot: string, workflowOperationId: string) {
  return readApprovalRequests(
    harnessRootFor(projectRoot),
    readCommittedOperations(harnessRootFor(projectRoot)),
    workflowOperationId,
  );
}

function lifecycleEventsFor(projectRoot: string, workflowOperationId: string) {
  const repository = new LedgerRepository({
    projectRoot,
    readBaseline: () => headOf(projectRoot),
  });
  return repository
    .replay()
    .events.filter((event) => event.workflow_operation_id === workflowOperationId)
    .sort((left, right) => left.sequence - right.sequence);
}

async function approveAndResume(
  deps: OrchestratorDependencies,
  outcome: OrchestrationOutcome,
): Promise<OrchestrationOutcome> {
  if (outcome.status !== "approval_required") {
    throw new Error(`expected approval_required, got ${outcome.status}`);
  }
  const workflowOperationId = outcome.required.workflow_operation_id;
  await resolveApproval(deps, {
    requestId: outcome.required.request_id,
    decision: "approve",
    actor: "human:reviewer",
  });
  return resumeIteration(deps, workflowOperationId, undefined);
}

describe("phase orchestrator", { timeout: 30000 }, () => {
  it("runs a full iteration from intent to a completed snapshot, pausing only for approvals", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-demo", newId);
    const fake = recordingExecutor();
    const deps = makeDeps(projectRoot, newId, { execute: fake.executor });

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    expect(outcome.status).toBe("approval_required");
    if (outcome.status !== "approval_required") return;
    const baselineRequest = outcome.required;
    expect(baselineRequest.object_type).toBe("RequirementBaseline");
    expect(baselineRequest.resume_command).toContain("harness resume");

    // A resume without a decision re-uses the pending request instead of
    // minting a duplicate.
    const again = await resumeIteration(deps, baselineRequest.workflow_operation_id, undefined);
    expect(again.status).toBe("approval_required");
    if (again.status !== "approval_required") return;
    expect(again.required.request_id).toBe(baselineRequest.request_id);
    expect(approvalRequestsFor(projectRoot, baselineRequest.workflow_operation_id)).toHaveLength(1);

    outcome = await approveAndResume(deps, again);
    expect(outcome.status).toBe("approval_required");
    if (outcome.status !== "approval_required") return;
    expect(outcome.required.object_type).toBe("ImpactSet");

    outcome = await approveAndResume(deps, outcome);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;

    // The executor ran exactly once; the snapshot is anchored and committed.
    expect(fake.calls).toHaveLength(1);
    const snapshot = readLatestSnapshot(projectRoot);
    expect(snapshot?.snapshot_id).toBe(outcome.snapshotId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.evidence.length).toBeGreaterThan(0);

    // Lifecycle events are strictly ordered and bracket the committed phases.
    const events = lifecycleEventsFor(projectRoot, outcome.workflowOperationId);
    assertLifecycleOrder(events);
    const eventTypes = events.map((event) => event.event_type);
    expect(eventTypes[0]).toBe("OperationStarted");
    expect(eventTypes.at(-1)).toBe("OperationCompleted");
    expect(eventTypes).toContain("ApprovalRequired");
    expect(eventTypes).toContain("PlanAccepted");
    expect(eventTypes).toContain("BeforeContextCompile");
    expect(eventTypes).toContain("ContextCompiled");
    expect(eventTypes).toContain("GateCompleted");
    expect(eventTypes).toContain("EvaluationCompleted");
    expect(eventTypes.indexOf("BeforeContextCompile")).toBeLessThan(
      eventTypes.indexOf("ContextCompiled"),
    );

    // Terminal state leaves a clean worktree: the ledger landed in Git.
    expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");
    expect(findOpenWorkflowOperation(projectRoot, () => headOf(projectRoot))).toBeUndefined();
  });

  it("commits deduped audit findings after evaluation and surfaces them in status", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-audit-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-audit", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const deps = makeDeps(projectRoot, newId, { execute: recordingExecutor().executor });

    const driveToCompletion = async (
      intent: string,
      iterationId?: string,
    ): Promise<OrchestrationOutcome> => {
      let outcome = await runIteration(deps, {
        intent,
        ...(iterationId === undefined ? {} : { iterationId }),
      });
      while (outcome.status === "approval_required") {
        outcome = await approveAndResume(deps, outcome);
      }
      return outcome;
    };

    // Like the CLI, the first iteration reuses the bootstrap iteration node.
    const first = await driveToCompletion(INTENT, bootstrapped.value.iterationId);
    expect(first.status).toBe("completed");
    if (first.status !== "completed") return;

    // A fresh project has no design documents: the post-evaluation audit
    // commits one proposed Finding node per missing domain.
    const findingNodesRoot = join(projectRoot, ".harness", "artifacts", "finding-nodes");
    const designFindingIds = readdirSync(findingNodesRoot)
      .filter((entry) => entry.startsWith("finding_audit-missing-design-artifact-"))
      .sort();
    expect(designFindingIds.length).toBeGreaterThan(0);
    for (const id of designFindingIds) {
      expect(readdirSync(join(findingNodesRoot, id))).toEqual(["1.json"]);
    }

    // The gaps surface in project status as blockers without a manual audit.
    const status = collectProjectStatus(projectRoot);
    for (const id of designFindingIds) {
      expect(status.blockers).toContain(`blocking finding ${id}`);
    }
    expect(status.next_action).toContain("repair blocker: blocking finding finding_audit-");

    // A second iteration re-runs the audit: the same gaps dedupe to the same
    // Finding ids (still revision 1, same feedback record) instead of
    // duplicating, and the new iteration gets its own BLOCKS edge.
    const firstFindingId = designFindingIds[0] as string;
    const feedbackPath = join(
      projectRoot,
      ".harness",
      "artifacts",
      "findings",
      firstFindingId,
      "proposed.json",
    );
    const feedbackBefore = readFileSync(feedbackPath, "utf8");
    const second = await driveToCompletion("add the second capability");
    expect(second.status).toBe("completed");
    if (second.status !== "completed") return;
    const designFindingIdsAfter = readdirSync(findingNodesRoot)
      .filter((entry) => entry.startsWith("finding_audit-missing-design-artifact-"))
      .sort();
    expect(designFindingIdsAfter).toEqual(designFindingIds);
    for (const id of designFindingIdsAfter) {
      expect(readdirSync(join(findingNodesRoot, id))).toEqual(["1.json"]);
    }
    expect(readFileSync(feedbackPath, "utf8")).toBe(feedbackBefore);

    const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      const edges: EdgeRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = pageEdges(database, {
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        });
        edges.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const blocking = edges.filter(
        (edge) => edge.type === "BLOCKS" && edge.source_id === firstFindingId,
      );
      expect(blocking.map((edge) => edge.target_id).sort()).toEqual(
        [first.iterationId, second.iterationId].sort(),
      );
    } finally {
      database.close();
    }
  });

  it("keeps a deferred interactive decision resumable and continues in the same session", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-interactive", newId);
    const answers: (string | null)[] = [null, "approve", "approve"];
    const prompter: ApprovalPrompter = {
      prompt: () => Promise.resolve(answers.shift() ?? null),
    };
    const deps = makeDeps(projectRoot, newId, {
      execute: recordingExecutor().executor,
      prompter,
      decisionActor: "human:local",
    });

    // EOF on the first prompt defers: the proposal stays proposed and resumable.
    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    expect(outcome.status).toBe("approval_required");
    if (outcome.status !== "approval_required") return;
    const workflowOperationId = outcome.required.workflow_operation_id;

    // The next session approves the pending baseline request, then the new
    // impact request, and the pipeline runs to completion in one drive.
    outcome = await resumeIteration(deps, workflowOperationId, undefined);
    expect(outcome.status).toBe("completed");
    expect(answers).toHaveLength(0);
  });

  it("returns typed clarification questions without opening an operation", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-input", newId);
    const deps = makeDeps(projectRoot, newId, {
      interpret: () => undefined,
    });
    const outcome = await runIteration(deps, { intent: INTENT });
    expect(outcome.status).toBe("input_required");
    if (outcome.status !== "input_required") return;
    expect(outcome.questions.length).toBeGreaterThan(0);
    expect(findOpenWorkflowOperation(projectRoot, () => headOf(projectRoot))).toBeUndefined();
  });

  it("blocks on a failed mandatory gate and completes after the human repair", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-gate", newId);
    // The broken marker is worktree state, not a commit: repairing it must not
    // move the Git baseline the iteration binds to.
    writeFileSync(join(projectRoot, "BROKEN"), "marker", "utf8");

    const gateCalls: number[] = [];
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "check_marker",
        version: "1.0.0",
        description: "fail while the BROKEN marker file exists",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        output_schema: {
          type: "object",
          properties: {
            exit_code: { type: "integer" },
            summary: { type: "string" },
            log_summary: { type: "string" },
            artifacts: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["exit_code"],
          additionalProperties: false,
        },
        allowed_phases: ["verification"],
        resource_patterns: [],
        risk: "low",
        side_effect_class: "none",
        requires_approval: false,
        timeout_ms: 50,
        retry_class: "none",
        max_retries: 0,
        max_invocations_per_run: 10,
        idempotent: true,
        reconciliation: "provider",
      },
      () => {
        gateCalls.push(1);
        const broken = existsSync(join(projectRoot, "BROKEN"));
        return {
          exit_code: broken ? 1 : 0,
          summary: broken ? "marker file BROKEN still present" : "marker file removed",
          log_summary: "marker check",
          artifacts: {},
        };
      },
    );
    const gates: readonly GateDefinition[] = [
      normalizeGateDefinition({
        gate_id: "gate_marker",
        layer: "project",
        name: "marker gate",
        mandatory: true,
        subject_id: "project_marker",
        tool: "check_marker",
      }),
    ];
    const deps = makeDeps(projectRoot, newId, {
      execute: recordingExecutor().executor,
      gates,
      toolRegistry: registry,
    });

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    outcome = await approveAndResume(deps, outcome);
    outcome = await approveAndResume(deps, outcome);
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.reason).toBe("repairable_gate_failure");
    expect(outcome.snapshotId).toBeDefined();
    const blockedSnapshot = readLatestSnapshot(projectRoot);
    expect(blockedSnapshot?.status).toBe("blocked");
    expect(blockedSnapshot?.resume_phase).toBe("verify");

    // Human repair: remove the marker; the code digest changes, so the verify
    // phase re-runs instead of replaying the stale verdict.
    rmSync(join(projectRoot, "BROKEN"));

    outcome = await resumeIteration(deps, outcome.workflowOperationId, undefined);
    expect(outcome.status).toBe("completed");
    expect(gateCalls).toHaveLength(2);

    // The repaired finding is closed by current evidence only.
    const finding = JSON.parse(
      readFileSync(
        join(projectRoot, ".harness", "artifacts", "findings", "finding_marker", "closed.json"),
        "utf8",
      ),
    ) as { status: string };
    expect(finding.status).toBe("closed");
  });

  it("reconciles a crashed run on resume without duplicating runs or side effects", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-crash", newId);
    let calls = 0;
    const deps = makeDeps(projectRoot, newId, {
      execute: (envelope) => {
        calls += 1;
        if (calls === 1) {
          // Simulated process crash: no terminal record, no cleanup.
          return Promise.reject(new Error("simulated process crash"));
        }
        return Promise.resolve(claimedResult(envelope, "after-resume"));
      },
    });

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    outcome = await approveAndResume(deps, outcome);
    if (outcome.status !== "approval_required") {
      throw new Error(`expected pipeline to pause before execute, got ${outcome.status}`);
    }
    const workflowOperationId = outcome.required.workflow_operation_id;

    // The crash propagates out of the drive, leaving the operation mid-run.
    await expect(approveAndResume(deps, outcome)).rejects.toThrow("simulated process crash");

    outcome = await resumeIteration(deps, workflowOperationId, undefined);
    expect(outcome.status).toBe("completed");
    expect(calls).toBe(2);

    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
    });
    const replay = repository.replay();
    const resumes = replay.edges.filter((edge) => edge.type === "RESUMES");
    expect(resumes).toHaveLength(1);

    // Exactly two runs: the interrupted one carries the only RunInterrupted
    // record, the successor the only terminal success-path record.
    const runsDirectory = join(projectRoot, ".harness", "artifacts", "runs");
    const runIds = Array.from(
      new Set(
        replay.edges
          .filter((edge) => edge.type === "RESUMES")
          .flatMap((edge) => [edge.source_id, edge.target_id]),
      ),
    );
    expect(runIds).toHaveLength(2);
    let interruptedRecords = 0;
    let terminalRecords = 0;
    for (const runId of runIds) {
      for (const file of readdirSync(join(runsDirectory, runId))) {
        const record = JSON.parse(readFileSync(join(runsDirectory, runId, file), "utf8")) as {
          record_kind: string;
        };
        if (record.record_kind === "run_interrupted") interruptedRecords += 1;
        if (record.record_kind === "run_terminated") terminalRecords += 1;
      }
    }
    expect(interruptedRecords).toBe(1);
    expect(terminalRecords).toBe(1);
  });

  it("re-executes the task when the committed evaluation failed", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-eval", newId);
    let evaluations = 0;
    const evaluate: EvaluationPort = (input) => {
      evaluations += 1;
      const base = createDefaultEvaluationPort()(input);
      if (evaluations === 1) {
        return Promise.resolve({
          ...base,
          passed: false,
          mandatoryFailures: ["outcome"],
          findings: [
            { id: "finding_eval_once", summary: "first run did not meet the outcome bar" },
          ],
          summary: "first run did not meet the outcome bar",
        });
      }
      return Promise.resolve(base);
    };
    const fake = recordingExecutor((envelope, call) =>
      claimedResult(envelope, `call-${String(call)}`),
    );
    const deps = makeDeps(projectRoot, newId, { execute: fake.executor, evaluate });

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    outcome = await approveAndResume(deps, outcome);
    outcome = await approveAndResume(deps, outcome);
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.reason).toBe("repairable_gate_failure");

    outcome = await resumeIteration(deps, outcome.workflowOperationId, undefined);
    expect(outcome.status).toBe("completed");
    expect(fake.calls).toHaveLength(2);
    expect(evaluations).toBe(2);
  });

  it("refuses a second iteration while one is still open", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-open", newId);
    const deps = makeDeps(projectRoot, newId, {
      execute: recordingExecutor().executor,
    });
    const outcome = await runIteration(deps, { intent: INTENT });
    expect(outcome.status).toBe("approval_required");
    await expect(runIteration(deps, { intent: "another change" })).rejects.toThrow(
      OrchestrationError,
    );
  });

  it("uses the built-in direct executor and integrity gate by default", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-defaults", newId);
    const deps = makeDeps(projectRoot, newId);
    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    outcome = await approveAndResume(deps, outcome);
    outcome = await approveAndResume(deps, outcome);
    expect(outcome.status).toBe("completed");
  });
});
