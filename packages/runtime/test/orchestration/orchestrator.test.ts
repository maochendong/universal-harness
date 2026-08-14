import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { renderTasksProjection } from "@universal-harness-internal/adapter-projection-markdown";
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";
import type { AgentRunResult, AgentTaskEnvelope } from "@universal-harness-internal/plugin-sdk";

import {
  OrchestrationError,
  abortIteration,
  assertLifecycleOrder,
  auditGraph,
  collectProjectStatus,
  createDefaultEvaluationPort,
  createGenericInterpreter,
  createNewProject,
  detectProjectionDrift,
  findOpenWorkflowOperation,
  normalizeGateDefinition,
  readApprovalDecisions,
  readApprovalRequests,
  readLatestSnapshot,
  resolveApproval,
  resumeIteration,
  runIteration,
  ToolRegistry,
  WorkflowEngine,
  type ApprovalPrompter,
  type EvaluationPort,
  type GateDefinition,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type PlanTasksPort,
  type SnapshotRecord,
  type TaskSpecification,
} from "../../src/index.js";
import {
  harnessRootFor,
  LedgerRepository,
  contentDigest,
  readCommittedOperations,
  sha256Hex,
  type EdgeRecord,
  type NodeRecord,
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
    const blockingFindingIds = readdirSync(findingNodesRoot)
      .filter((entry) => !entry.startsWith("finding_audit-missing-design-artifact-"))
      .sort();
    expect(blockingFindingIds.length).toBeGreaterThan(0);

    // Non-blocking gaps surface as warnings, never as blockers; blocking gaps
    // (traceability, verification) stay blockers without a manual audit.
    const status = collectProjectStatus(projectRoot);
    for (const id of designFindingIds) {
      expect(status.blockers).not.toContain(`blocking finding ${id}`);
      expect(status.warnings).toContain(`warning finding ${id}`);
    }
    for (const id of blockingFindingIds) {
      expect(status.blockers).toContain(`blocking finding ${id}`);
    }
    expect(status.next_action).toContain("repair blocker: blocking finding finding_audit-");

    // A second iteration re-runs the audit: the same gaps dedupe to the same
    // Finding ids (still revision 1, same feedback record) instead of
    // duplicating, and each blocking finding binds the new iteration too.
    const firstDesignId = designFindingIds[0] as string;
    const firstBlockingId = blockingFindingIds[0] as string;
    const feedbackPath = join(
      projectRoot,
      ".harness",
      "artifacts",
      "findings",
      firstDesignId,
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
      // A non-blocking finding never gets a BLOCKS edge.
      expect(
        edges.filter((edge) => edge.type === "BLOCKS" && edge.source_id === firstDesignId),
      ).toEqual([]);
      const blocking = edges.filter(
        (edge) => edge.type === "BLOCKS" && edge.source_id === firstBlockingId,
      );
      expect(blocking.map((edge) => edge.target_id).sort()).toEqual(
        [first.iterationId, second.iterationId].sort(),
      );
    } finally {
      database.close();
    }
  });

  it("rescans worktree documentation into the graph and supersedes resolved findings", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-rescan-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-rescan", intent: INTENT },
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

    const findingNodesRoot = join(projectRoot, ".harness", "artifacts", "finding-nodes");
    const apiContractFindingId = (): string | undefined => {
      const findingsRoot = join(projectRoot, ".harness", "artifacts", "findings");
      for (const entry of readdirSync(findingsRoot).sort()) {
        if (!entry.startsWith("finding_audit-missing-design-artifact-")) continue;
        const proposed = JSON.parse(
          readFileSync(join(findingsRoot, entry, "proposed.json"), "utf8"),
        ) as { summary?: string };
        if (proposed.summary?.includes("domain: api-contract") === true) return entry;
      }
      return undefined;
    };

    // First iteration without an API contract: the gap is committed.
    const first = await driveToCompletion(INTENT, bootstrapped.value.iterationId);
    expect(first.status).toBe("completed");
    const findingId = apiContractFindingId();
    expect(findingId).toBeDefined();
    if (findingId === undefined) return;

    // The user writes the document between iterations; the next completing
    // snapshot rescans it into the graph and the resolved gap is superseded.
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeFileSync(join(projectRoot, "docs", "api-contract.md"), "# API Contract\n");
    const second = await driveToCompletion("add the second capability");
    expect(second.status).toBe("completed");

    const revisions = readdirSync(join(findingNodesRoot, findingId)).sort();
    expect(revisions).toEqual(["1.json", "2.json"]);
    const superseded = JSON.parse(
      readFileSync(join(findingNodesRoot, findingId, "2.json"), "utf8"),
    ) as { status?: string };
    expect(superseded.status).toBe("superseded");

    // The scanned document is a graph CodeArtifact and the audit agrees the
    // domain is covered; no new finding replaces the superseded one.
    const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      const nodes: NodeRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = pageNodes(database, {
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        });
        nodes.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const doc = nodes.find(
        (node) => node.type === "CodeArtifact" && node.locator?.endsWith("docs/api-contract.md"),
      );
      expect(doc).toBeDefined();
      expect(doc?.extensions?.["harness.scan"]).toMatchObject({
        classification: "documentation",
      });
      const edges: EdgeRecord[] = [];
      let edgeCursor: string | undefined;
      do {
        const page = pageEdges(database, {
          limit: 500,
          ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
        });
        edges.push(...page.items);
        edgeCursor = page.nextCursor;
      } while (edgeCursor !== undefined);
      const report = auditGraph({ nodes, edges });
      expect(
        report.findings.some(
          (finding) =>
            finding.kind === "missing_design_artifact" &&
            finding.summary.includes("domain: api-contract"),
        ),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it("regenerates the tasks.md projection at snapshot and refuses hand edits", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-tasks-md-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-tasks-md", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const deps = makeDeps(projectRoot, newId, {
      execute: recordingExecutor().executor,
      tasksProjection: renderTasksProjection,
    });

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

    // Independent re-render over the current ledger state: the file on disk
    // must equal these bytes exactly.
    const expectedRender = (): string => {
      const completed = new Set<string>();
      const snapshotsDirectory = join(projectRoot, ".harness", "artifacts", "snapshots");
      for (const name of readdirSync(snapshotsDirectory)
        .filter((entry) => entry.endsWith(".json"))
        .sort()) {
        const record = JSON.parse(
          readFileSync(join(snapshotsDirectory, name), "utf8"),
        ) as SnapshotRecord;
        for (const outcome of record.run_outcomes) {
          if (outcome.outcome === "success" && outcome.id.startsWith("task_")) {
            completed.add(outcome.id);
          }
        }
      }
      const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
      try {
        const nodes: NodeRecord[] = [];
        let cursor: string | undefined;
        do {
          const page = pageNodes(database, {
            limit: 500,
            ...(cursor === undefined ? {} : { cursor }),
          });
          nodes.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        const edges: EdgeRecord[] = [];
        let edgeCursor: string | undefined;
        do {
          const page = pageEdges(database, {
            limit: 500,
            ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
          });
          edges.push(...page.items);
          edgeCursor = page.nextCursor;
        } while (edgeCursor !== undefined);
        return renderTasksProjection({ nodes, edges }, { completedTasks: [...completed].sort() })
          .markdown;
      } finally {
        database.close();
      }
    };

    const first = await driveToCompletion(INTENT, bootstrapped.value.iterationId);
    expect(first.status).toBe("completed");

    const tasksPath = join(projectRoot, ".harness", "projections", "views", "tasks.md");
    expect(existsSync(tasksPath)).toBe(true);
    const generated = readFileSync(tasksPath, "utf8");
    expect(generated).toContain("do not edit");
    expect(generated).toContain("- [x] T001 ");
    expect(generated).toBe(expectedRender());

    // A hand edit is drift: the next completing snapshot refuses to overwrite
    // the user's bytes, and drift detection proves the staleness.
    writeFileSync(tasksPath, `${generated}hand edit\n`);
    const second = await driveToCompletion("add the second capability");
    expect(second.status).toBe("completed");
    expect(readFileSync(tasksPath, "utf8")).toBe(`${generated}hand edit\n`);
    const drift = detectProjectionDrift(harnessRootFor(projectRoot), {
      path: "views/tasks.md",
      expectedDigest: sha256Hex(expectedRender()),
    });
    expect(drift.status).toBe("drifted");
  });

  it("commits a structured quality record per task at verify", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-quality-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-quality", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const deps = makeDeps(projectRoot, newId, { execute: recordingExecutor().executor });

    let outcome = await runIteration(deps, {
      intent: INTENT,
      iterationId: bootstrapped.value.iterationId,
    });
    while (outcome.status === "approval_required") {
      outcome = await approveAndResume(deps, outcome);
    }
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;

    const qualityRoot = join(projectRoot, ".harness", "artifacts", "quality", outcome.iterationId);
    const taskDirs = readdirSync(qualityRoot);
    expect(taskDirs).toHaveLength(1);
    const taskId = taskDirs[0] as string;
    const files = readdirSync(join(qualityRoot, taskId));
    expect(files).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(qualityRoot, taskId, files[0] as string), "utf8"),
    ) as Record<string, unknown> & {
      assertions: {
        description: string;
        verification: string;
        passed: boolean;
        evidence_ids: string[];
      }[];
    };
    expect(record.record_kind).toBe("task_quality_record");
    expect(record.task_id).toBe(taskId);
    expect(record.iteration_id).toBe(outcome.iterationId);
    expect(record.verdict).toBe("passed");
    expect(record.metrics).toEqual({
      gates_total: 1,
      gates_passed: 1,
      mandatory_gates_failed: 0,
      coverage: null,
      lint_passed: null,
    });

    // One machine-checkable row per acceptance assertion of the task, bound
    // to the mandatory suite's evidence.
    const taskNode = JSON.parse(
      readFileSync(join(projectRoot, ".harness", "artifacts", "tasks", `${taskId}.json`), "utf8"),
    ) as { extensions: { "harness.plan": { acceptance: { description: string }[] } } };
    const acceptance = taskNode.extensions["harness.plan"].acceptance;
    expect(record.assertions).toHaveLength(acceptance.length);
    expect(record.assertions[0]?.description).toBe(acceptance[0]?.description);
    expect(record.assertions[0]?.passed).toBe(true);
    expect(record.assertions[0]?.evidence_ids).toEqual(["evidence_ledger_integrity"]);

    // The digest seals the content.
    const { digest, ...content } = record;
    expect(digest).toBe(contentDigest(content));
  });

  it("records failed quality rows at a blocked verify and refreshes them after repair", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-quality-fail", newId);
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

    // The failed gate still produced a quality record, rows marked as failed.
    const qualityRoot = join(projectRoot, ".harness", "artifacts", "quality", outcome.iterationId);
    const taskDirs = readdirSync(qualityRoot);
    expect(taskDirs).toHaveLength(1);
    const taskId = taskDirs[0] as string;
    const failedFiles = readdirSync(join(qualityRoot, taskId));
    expect(failedFiles).toHaveLength(1);
    const failed = JSON.parse(
      readFileSync(join(qualityRoot, taskId, failedFiles[0] as string), "utf8"),
    ) as {
      verdict: string;
      metrics: { mandatory_gates_failed: number };
      assertions: { passed: boolean; evidence_ids: string[] }[];
    };
    expect(failed.verdict).toBe("failed");
    expect(failed.metrics.mandatory_gates_failed).toBe(1);
    expect(failed.assertions[0]?.passed).toBe(false);
    expect(failed.assertions[0]?.evidence_ids).toEqual(["evidence_marker"]);

    // Resume without a repair replays the stored verdict: no duplicate record.
    outcome = await resumeIteration(deps, outcome.workflowOperationId, undefined);
    expect(outcome.status).toBe("blocked");
    expect(readdirSync(join(qualityRoot, taskId))).toEqual(failedFiles);
    expect(gateCalls).toHaveLength(1);

    // Repair: the worktree digest changes, the record goes stale with its
    // bindings and a fresh passed record lands at a new digest-versioned
    // path; the failed one stays as history.
    rmSync(join(projectRoot, "BROKEN"));
    outcome = await resumeIteration(deps, outcome.workflowOperationId, undefined);
    expect(outcome.status).toBe("completed");
    expect(gateCalls).toHaveLength(2);
    const refreshedFiles = readdirSync(join(qualityRoot, taskId)).sort();
    expect(refreshedFiles).toHaveLength(2);
    const freshName = refreshedFiles.find((name) => name !== failedFiles[0]) as string;
    const fresh = JSON.parse(readFileSync(join(qualityRoot, taskId, freshName), "utf8")) as {
      verdict: string;
      assertions: { passed: boolean }[];
    };
    expect(fresh.verdict).toBe("passed");
    expect(fresh.assertions[0]?.passed).toBe(true);
  });

  it("plans, executes and tracks a three-task iteration with one approval", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-multitask-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-multitask", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const fake = recordingExecutor();
    const planTasks: PlanTasksPort = ({ requirements, impactPaths, gateIds }) => {
      const requirementId = requirements[0]?.id ?? "requirement_none";
      const spec = (
        id: string,
        objective: string,
        dependencies: readonly string[],
      ): TaskSpecification => ({
        id,
        objective,
        impact_paths: impactPaths.map((path) => [...path]),
        expected_outputs: [requirementId],
        capabilities: [],
        tools: [],
        dependencies: [...dependencies],
        risk: "low",
        budget: { steps: 30, tokens: 120000 },
        acceptance: [
          { description: `${objective} done`, verification: "mandatory gate suite passes" },
        ],
        required_gates: [...gateIds],
      });
      return [
        spec("task_alpha", "alpha", []),
        spec("task_beta", "beta", ["task_alpha"]),
        spec("task_gamma", "gamma", ["task_beta"]),
      ];
    };
    const deps = makeDeps(projectRoot, newId, {
      execute: fake.executor,
      planTasks,
      tasksProjection: renderTasksProjection,
    });

    let outcome = await runIteration(deps, {
      intent: INTENT,
      iterationId: bootstrapped.value.iterationId,
    });
    while (outcome.status === "approval_required") {
      outcome = await approveAndResume(deps, outcome);
    }
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;

    // The whole plan was covered by exactly the baseline and impact set
    // approvals -- no per-task approval requests.
    expect(approvalRequestsFor(projectRoot, outcome.workflowOperationId)).toHaveLength(2);

    // Envelopes went out in dependency order.
    expect(fake.calls.map((envelope) => envelope.task_id)).toEqual([
      "task_alpha",
      "task_beta",
      "task_gamma",
    ]);

    // The graph carries three Task nodes and two DEPENDS_ON edges, and the
    // projection renders the numbered list with dependency annotations.
    const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      const nodes: NodeRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = pageNodes(database, {
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        });
        nodes.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const edges: EdgeRecord[] = [];
      let edgeCursor: string | undefined;
      do {
        const page = pageEdges(database, {
          limit: 500,
          ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
        });
        edges.push(...page.items);
        edgeCursor = page.nextCursor;
      } while (edgeCursor !== undefined);
      expect(nodes.filter((node) => node.type === "Task")).toHaveLength(3);
      expect(edges.filter((edge) => edge.type === "DEPENDS_ON")).toHaveLength(2);
      // Every task ended marked accepted; progress is complete.
      const status = collectProjectStatus(projectRoot);
      expect(status.task_progress).toEqual({ completed: 3, total: 3 });
    } finally {
      database.close();
    }

    const tasksMarkdown = readFileSync(
      join(projectRoot, ".harness", "projections", "views", "tasks.md"),
      "utf8",
    );
    expect(tasksMarkdown).toContain("- [x] T001 alpha");
    expect(tasksMarkdown).toContain("- [x] T002 beta (depends on T001)");
    expect(tasksMarkdown).toContain("- [x] T003 gamma (depends on T002)");
  });

  it("reports 2/3 progress and resumes only the unfinished tasks", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-progress-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-progress", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const calls: string[] = [];
    let blockGamma = true;
    const planTasks: PlanTasksPort = ({ requirements, impactPaths, gateIds }) => {
      const requirementId = requirements[0]?.id ?? "requirement_none";
      const spec = (id: string, dependencies: readonly string[]): TaskSpecification => ({
        id,
        objective: id,
        impact_paths: impactPaths.map((path) => [...path]),
        expected_outputs: [requirementId],
        capabilities: [],
        tools: [],
        dependencies: [...dependencies],
        risk: "low",
        budget: { steps: 30, tokens: 120000 },
        acceptance: [{ description: `${id} done`, verification: "mandatory gate suite passes" }],
        required_gates: [...gateIds],
      });
      return [
        spec("task_alpha", []),
        spec("task_beta", ["task_alpha"]),
        spec("task_gamma", ["task_beta"]),
      ];
    };
    const deps = makeDeps(projectRoot, newId, {
      planTasks,
      execute: (envelope) => {
        calls.push(envelope.task_id);
        if (blockGamma && envelope.task_id === "task_gamma") {
          const result = claimedResult(envelope, "gamma blocked");
          return Promise.resolve({
            ...result,
            completion_claimed: false,
            summary: "gamma needs human input",
          });
        }
        return Promise.resolve(claimedResult(envelope, "ok"));
      },
    });

    let outcome = await runIteration(deps, {
      intent: INTENT,
      iterationId: bootstrapped.value.iterationId,
    });
    outcome = await approveAndResume(deps, outcome);
    outcome = await approveAndResume(deps, outcome);
    expect(outcome.status).toBe("blocked");
    expect(calls).toEqual(["task_alpha", "task_beta", "task_gamma"]);

    // Two of three tasks are marked accepted: status reports 2/3 and points
    // at the third task.
    const blocked = collectProjectStatus(projectRoot);
    expect(blocked.task_progress).toEqual({
      completed: 2,
      total: 3,
      next_task_id: "task_gamma",
    });
    expect(blocked.next_action).toContain("2/3");
    expect(blocked.next_action).toContain("task_gamma");

    // Resume: the finished tasks are skipped, only the unfinished one runs.
    blockGamma = false;
    if (outcome.status !== "blocked") return;
    outcome = await resumeIteration(deps, outcome.workflowOperationId, undefined);
    expect(outcome.status).toBe("completed");
    expect(calls).toEqual(["task_alpha", "task_beta", "task_gamma", "task_gamma"]);
    expect(collectProjectStatus(projectRoot).task_progress).toEqual({ completed: 3, total: 3 });
  });

  it("reconciles a crash mid-task-list and re-executes only the crashed task onward", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-multicrash-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-multicrash", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const calls: string[] = [];
    const planTasks: PlanTasksPort = ({ requirements, impactPaths, gateIds }) => {
      const requirementId = requirements[0]?.id ?? "requirement_none";
      const spec = (id: string, dependencies: readonly string[]): TaskSpecification => ({
        id,
        objective: id,
        impact_paths: impactPaths.map((path) => [...path]),
        expected_outputs: [requirementId],
        capabilities: [],
        tools: [],
        dependencies: [...dependencies],
        risk: "low",
        budget: { steps: 30, tokens: 120000 },
        acceptance: [{ description: `${id} done`, verification: "mandatory gate suite passes" }],
        required_gates: [...gateIds],
      });
      return [
        spec("task_alpha", []),
        spec("task_beta", ["task_alpha"]),
        spec("task_gamma", ["task_beta"]),
      ];
    };
    const deps = makeDeps(projectRoot, newId, {
      planTasks,
      execute: (envelope) => {
        calls.push(envelope.task_id);
        if (
          envelope.task_id === "task_beta" &&
          calls.filter((id) => id === "task_beta").length === 1
        ) {
          // Simulated process crash: no terminal record, no cleanup.
          return Promise.reject(new Error("simulated process crash"));
        }
        return Promise.resolve(claimedResult(envelope, "ok"));
      },
    });

    let outcome = await runIteration(deps, {
      intent: INTENT,
      iterationId: bootstrapped.value.iterationId,
    });
    outcome = await approveAndResume(deps, outcome);
    if (outcome.status !== "approval_required") {
      throw new Error(`expected pipeline to pause before execute, got ${outcome.status}`);
    }
    const workflowOperationId = outcome.required.workflow_operation_id;
    await expect(approveAndResume(deps, outcome)).rejects.toThrow("simulated process crash");
    expect(calls).toEqual(["task_alpha", "task_beta"]);

    outcome = await resumeIteration(deps, workflowOperationId, undefined);
    expect(outcome.status).toBe("completed");
    // Alpha was never re-executed; beta got exactly one successor run.
    expect(calls).toEqual(["task_alpha", "task_beta", "task_beta", "task_gamma"]);
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
    });
    expect(repository.replay().edges.filter((edge) => edge.type === "RESUMES")).toHaveLength(1);
  });

  it("aborts an open operation and closes its pending approval requests", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-abort-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-abort", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const deps = makeDeps(projectRoot, newId, { execute: recordingExecutor().executor });

    const started = await runIteration(deps, {
      intent: INTENT,
      iterationId: bootstrapped.value.iterationId,
    });
    expect(started.status).toBe("approval_required");
    if (started.status !== "approval_required") return;
    const { request_id: requestId, workflow_operation_id: workflowOperationId } = started.required;

    // The approval blocker is visible before the abort.
    expect(collectProjectStatus(projectRoot).blockers).toContain(
      `approval request ${requestId} awaiting a decision`,
    );

    const aborted = await abortIteration(deps, {
      workflowOperationId,
      actor: "human:local",
    });
    expect(aborted.rejectedRequests).toEqual([requestId]);

    // Audit trail: an explicit reject decision by the aborting actor and a
    // terminal aborted operation record.
    const decisions = readApprovalDecisions(
      harnessRootFor(projectRoot),
      readCommittedOperations(harnessRootFor(projectRoot)),
      workflowOperationId,
    );
    const rejection = decisions.find((decision) => decision.request_id === requestId);
    expect(rejection?.decision).toBe("reject");
    expect(rejection?.actor).toBe("human:local");
    const engine = new WorkflowEngine({
      projectRoot,
      readBaseline: () => headOf(projectRoot),
    });
    expect(engine.getOperation(workflowOperationId)?.state).toBe("aborted");

    // Status is clean: no phantom approval blocker, iteration marked aborted,
    // and the project accepts a fresh iteration.
    const status = collectProjectStatus(projectRoot);
    expect(status.blockers).toEqual([]);
    expect(status.iteration?.state).toBe("aborted");
    expect(status.next_action).toContain("harness iterate");
    expect(findOpenWorkflowOperation(projectRoot, () => headOf(projectRoot))).toBeUndefined();
    const next = await runIteration(deps, { intent: "recover after the abort" });
    expect(next.status).toBe("approval_required");
  });

  it("lets a reject through baseline drift and aborts the sealed operation", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-drift-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-drift", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const deps = makeDeps(projectRoot, newId, { execute: recordingExecutor().executor });

    const started = await runIteration(deps, {
      intent: INTENT,
      iterationId: bootstrapped.value.iterationId,
    });
    expect(started.status).toBe("approval_required");
    if (started.status !== "approval_required") return;
    const { request_id: requestId, workflow_operation_id: workflowOperationId } = started.required;

    // The Git baseline advances after the checkpoint: resume and approve are
    // sealed by the drift guard, exactly the dead end the dogfood hit. The
    // external commit needs a repo-local identity: CI runners have no global
    // git user.name/user.email (same strings as the fixture repo helper).
    git(projectRoot, "config", "user.name", "Harness Test");
    git(projectRoot, "config", "user.email", "harness-test@example.com");
    git(projectRoot, "commit", "--allow-empty", "-m", "external commit");
    await expect(resumeIteration(deps, workflowOperationId, undefined)).rejects.toThrow(
      /baseline drifted/u,
    );
    await expect(
      resolveApproval(deps, { requestId, decision: "approve", actor: "human:local" }),
    ).rejects.toThrow(/baseline drifted/u);

    // A reject applies nothing, so it passes the drift seal; the operation
    // itself stays blocked until the explicit abort.
    const rejected = await resolveApproval(deps, {
      requestId,
      decision: "reject",
      actor: "human:local",
    });
    expect(rejected.decision).toBe("reject");
    expect(findOpenWorkflowOperation(projectRoot, () => headOf(projectRoot))).toBe(
      workflowOperationId,
    );

    const aborted = await abortIteration(deps, {
      workflowOperationId,
      actor: "human:local",
      reason: "baseline drifted beyond recovery",
    });
    expect(aborted.rejectedRequests).toEqual([]);
    expect(findOpenWorkflowOperation(projectRoot, () => headOf(projectRoot))).toBeUndefined();
    expect(collectProjectStatus(projectRoot).blockers).toEqual([]);
    const next = await runIteration(deps, { intent: "recover after the drift abort" });
    expect(next.status).toBe("approval_required");
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
