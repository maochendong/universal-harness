import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { renderTasksProjection } from "@universal-harness-internal/adapter-projection-markdown";
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";
import type { AgentRunResult, AgentTaskEnvelope } from "@universal-harness-internal/plugin-sdk";

import {
  OrchestrationError,
  abortIteration,
  approveGraphEdge,
  assertLifecycleOrder,
  auditGraph,
  collectProjectStatus,
  createDefaultEvaluationPort,
  createGenericInterpreter,
  createNewProject,
  detectProjectionDrift,
  findOpenWorkflowOperation,
  hashWorktreeCode,
  normalizeGateDefinition,
  proposeGraphEdge,
  readApprovalDecisions,
  readApprovalRequests,
  readLatestSnapshot,
  resolveApproval,
  resolveFinding,
  resumeIteration,
  runIteration,
  ToolRegistry,
  WorkflowEngine,
  ORCHESTRATION_PHASES,
  type ApprovalPrompter,
  type EvaluationPort,
  type GateDefinition,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
  type PhaseProgressEvent,
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
  makeRepo,
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

describe("worktree code binding", () => {
  it("does not change when a Git-ignored gate output is created", () => {
    const projectRoot = makeRepo({
      ".gitignore": "target/\n",
      "src/app.ts": "export const value = 1;\n",
    });
    const before = hashWorktreeCode(projectRoot);

    mkdirSync(join(projectRoot, "target"), { recursive: true });
    writeFileSync(join(projectRoot, "target", "test-report.xml"), "generated", "utf8");

    expect(hashWorktreeCode(projectRoot)).toBe(before);
  });

  it("changes when an untracked source file is created", () => {
    const projectRoot = makeRepo({ "src/app.ts": "export const value = 1;\n" });
    const before = hashWorktreeCode(projectRoot);

    writeFileSync(join(projectRoot, "src/new.ts"), "export const added = true;\n", "utf8");

    expect(hashWorktreeCode(projectRoot)).not.toBe(before);
  });

  it("changes when a tracked source file is edited", () => {
    const projectRoot = makeRepo({ "src/app.ts": "export const value = 1;\n" });
    const before = hashWorktreeCode(projectRoot);

    writeFileSync(join(projectRoot, "src/app.ts"), "export const value = 2;\n", "utf8");

    expect(hashWorktreeCode(projectRoot)).not.toBe(before);
  });

  it("binds a symbolic link without following external content", () => {
    const projectRoot = makeRepo({ "src/app.ts": "export const value = 1;\n" });
    const externalRoot = makeTempDir("harness-code-binding-external-");
    const externalFile = join(externalRoot, "outside.txt");
    writeFileSync(externalFile, "first", "utf8");
    symlinkSync(externalFile, join(projectRoot, "outside-link"));
    const before = hashWorktreeCode(projectRoot);

    writeFileSync(externalFile, "second", "utf8");

    expect(hashWorktreeCode(projectRoot)).toBe(before);
  });

  it("changes when a symbolic link target changes", () => {
    const projectRoot = makeRepo({ "src/app.ts": "export const value = 1;\n" });
    const externalRoot = makeTempDir("harness-code-binding-target-");
    const firstTarget = join(externalRoot, "first.txt");
    const secondTarget = join(externalRoot, "second.txt");
    writeFileSync(firstTarget, "same", "utf8");
    writeFileSync(secondTarget, "same", "utf8");
    const link = join(projectRoot, "outside-link");
    symlinkSync(firstTarget, link);
    const before = hashWorktreeCode(projectRoot);

    rmSync(link);
    symlinkSync(secondTarget, link);

    expect(hashWorktreeCode(projectRoot)).not.toBe(before);
  });
});

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

const FIVE_DIMENSION_NAMES = [
  "outcome",
  "safety",
  "trajectory",
  "correct_failure",
  "efficiency",
] as const;

const completeEvaluation: EvaluationPort = (input) => {
  const dimensions = FIVE_DIMENSION_NAMES.map((dimension) => ({
    dimension,
    available: true,
    score: 1,
    threshold: dimension === "efficiency" ? 0 : 1,
    passed: true,
    mandatory: dimension === "outcome" || dimension === "safety",
    deterministic: true,
    scorer: `deterministic/${dimension}`,
    reason: `${dimension} passed`,
    confidence: null,
  }));
  const extension = {
    case_id: `case_${input.taskId.slice("task_".length)}`,
    case_digest: "b".repeat(64),
    visibility: input.visibility,
    coverage: {
      visibility: input.visibility,
      available_fields: ["outcome", "termination_reason", "usage"],
      unavailable_fields: [
        "tool_activity_summary",
        "step_sequence",
        "tool_validity",
        "repeat_detection",
      ],
      ratio: 0.428571,
    },
    dimensions,
    mandatory_failures: [],
    passed: true,
  };
  const record = {
    protocol_version: "1.0.0",
    record_kind: "evidence",
    evidence_id: `evidence_evaluation_${input.taskId.slice("task_".length)}`,
    evidence_type: "evaluation_report",
    subject_id: input.taskId,
    digest: contentDigest({
      evidence_type: "evaluation_report",
      subject_id: input.taskId,
      extension,
    }),
    provisional: false,
    created_at: input.now,
    extensions: { "harness.evaluation": extension },
  };
  return {
    evidenceId: record.evidence_id,
    passed: true,
    mandatoryFailures: [],
    findings: [],
    summary: "five-dimensional evaluation passed",
    record,
  };
};

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
    const deps = makeDeps(projectRoot, newId, {
      execute: fake.executor,
      evaluate: completeEvaluation,
    });

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

    // Evaluation evidence is graph-native: the accepted case evaluates both
    // the Task and its concrete Run, so status coverage and task freshness are
    // derived from explicit edges instead of an out-of-band artifact.
    const status = collectProjectStatus(projectRoot);
    expect(status.evaluation_coverage).toEqual({ evaluated: 1, total: 1 });
    const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      const nodes = pageNodes(database, { type: "EvaluationCase", limit: 10 }).items;
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({ status: "accepted", source: "evaluation" });
      expect(nodes[0]?.extensions?.["harness.evaluation"]).toMatchObject({
        dimensions: FIVE_DIMENSION_NAMES.map((dimension) =>
          expect.objectContaining({ dimension, passed: true }),
        ),
        mandatory_failures: [],
        coverage: expect.objectContaining({ ratio: 0.428571 }),
      });
      const edges = pageEdges(database, { limit: 100 }).items;
      expect(
        edges.filter((edge) => edge.type === "EVALUATES" && edge.source_id === nodes[0]?.id),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target_id: fake.calls[0]?.task_id }),
          expect.objectContaining({ target_id: expect.stringMatching(/^run_/u) }),
        ]),
      );
    } finally {
      database.close();
    }

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
    // The plan phase wires IMPLEMENTS edges and the verify phase materializes
    // evidence nodes with SUPPORTS edges: a fully wired iteration produces no
    // blocking audit finding at all -- traceability_gap, task_orphan,
    // task_stale and missing_verification all stay silent.
    expect(blockingFindingIds).toEqual([]);
    const allFindingIds = readdirSync(findingNodesRoot);
    expect(allFindingIds.some((entry) => entry.startsWith("finding_audit-traceability-gap-"))).toBe(
      false,
    );
    expect(allFindingIds.some((entry) => entry.startsWith("finding_audit-task-orphan-"))).toBe(
      false,
    );
    expect(allFindingIds.some((entry) => entry.startsWith("finding_audit-task-stale-"))).toBe(
      false,
    );
    expect(
      allFindingIds.some((entry) => entry.startsWith("finding_audit-missing-verification-")),
    ).toBe(false);

    // Non-blocking gaps surface as warnings, never as blockers.
    const status = collectProjectStatus(projectRoot);
    expect(status.blockers).toEqual([]);
    for (const id of designFindingIds) {
      expect(status.warnings).toContain(`warning finding ${id}`);
    }

    // A second iteration re-runs the audit: the same gaps dedupe to the same
    // Finding ids (still revision 1, same feedback record) instead of
    // duplicating.
    const firstDesignId = designFindingIds[0] as string;
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
    writeFileSync(
      join(projectRoot, "docs", "api-contract.md"),
      "# API Contract\n\n- POST /retrieve -- retrieval endpoint\n",
    );
    git(projectRoot, "add", "docs/api-contract.md");
    git(projectRoot, "commit", "-m", "docs: add API contract baseline");
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
        api_entries: ["API Contract", "POST /retrieve"],
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

  it("binds configured repository paths into the governed task envelope", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-task-scope", newId);
    const fake = recordingExecutor((envelope) => {
      mkdirSync(join(projectRoot, "src"), { recursive: true });
      writeFileSync(join(projectRoot, "src", "generated.ts"), "export const generated = true;\n");
      return {
        ...claimedResult(envelope, "wrote governed source"),
        change_summary: {
          files_changed: 1,
          insertions: 1,
          deletions: 0,
          paths: ["src/generated.ts"],
        },
      };
    });
    const deps = makeDeps(projectRoot, newId, {
      execute: fake.executor,
      taskEnvelopeScope: () => ({
        allowed_read_paths: ["docs", "src"],
        proposed_write_paths: ["scripts", "src"],
      }),
    });

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    while (outcome.status === "approval_required") {
      outcome = await approveAndResume(deps, outcome);
    }

    expect(outcome.status).toBe("completed");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.allowed_read_paths).toEqual(["docs", "src"]);
    expect(fake.calls[0]?.proposed_write_paths).toEqual(["scripts", "src"]);
    if (outcome.status !== "completed") return;
    const snapshot = readLatestSnapshot(projectRoot);
    expect(snapshot?.final_commit).toBe(outcome.sourceCommit);
    expect(outcome.sourceCommit).not.toBe(outcome.finalCommit);
    expect(git(projectRoot, "show", `${outcome.sourceCommit}:src/generated.ts`)).toContain(
      "generated = true",
    );
    expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");
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

  it("materializes gate evidence as graph nodes and supersedes missing_verification once wired", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-evidence-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-evidence", intent: INTENT },
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

    const readGraph = (): { nodes: NodeRecord[]; edges: EdgeRecord[] } => {
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
        return { nodes, edges };
      } finally {
        database.close();
      }
    };

    // Iteration 1: the baseline acceptance test is wired to the passing
    // mandatory gate's evidence; no missing_verification finding exists.
    const first = await driveToCompletion(INTENT, bootstrapped.value.iterationId);
    expect(first.status).toBe("completed");
    let graph = readGraph();
    const evidenceNode = graph.nodes.find((node) => node.id === "evidence_ledger_integrity");
    expect(evidenceNode?.id).toBe("evidence_ledger_integrity");
    expect(evidenceNode?.status).toBe("accepted");
    const baselineTest = graph.nodes.find((node) => node.type === "Test");
    expect(baselineTest).toBeDefined();
    expect(
      graph.edges.some(
        (edge) =>
          edge.type === "SUPPORTS" &&
          edge.source_id === "evidence_ledger_integrity" &&
          edge.target_id === baselineTest?.id,
      ),
    ).toBe(true);
    expect(
      auditGraph({ nodes: graph.nodes, edges: graph.edges }).findings.some(
        (finding) => finding.kind === "missing_verification",
      ),
    ).toBe(false);

    // A test file written after adoption enters the graph at the completing
    // snapshot's rescan -- and the same snapshot wires it to the suite
    // evidence before the audit runs, so no missing_verification finding is
    // ever committed for it.
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(
      join(projectRoot, "src", "widget.test.js"),
      'import test from "node:test";\ntest("widget", () => {});\n',
    );
    git(projectRoot, "add", "src/widget.test.js");
    git(projectRoot, "commit", "-m", "test: add widget baseline");
    const second = await driveToCompletion("add the widget test");
    expect(second.status).toBe("completed");
    graph = readGraph();
    const scannedTest = graph.nodes.find(
      (node) => node.type === "Test" && node.locator?.endsWith("src/widget.test.js"),
    );
    expect(scannedTest).toBeDefined();
    expect(
      graph.edges.some(
        (edge) =>
          edge.type === "SUPPORTS" &&
          edge.source_id === "evidence_ledger_integrity" &&
          edge.target_id === scannedTest?.id,
      ),
    ).toBe(true);
    expect(
      auditGraph({ nodes: graph.nodes, edges: graph.edges }).findings.some(
        (finding) => finding.kind === "missing_verification",
      ),
    ).toBe(false);
    const findingsRoot = join(projectRoot, ".harness", "artifacts", "findings");
    expect(
      readdirSync(findingsRoot).some((entry) =>
        entry.startsWith("finding_audit-missing-verification-"),
      ),
    ).toBe(false);
  });

  it("retires a resolved finding's BLOCKS edges when the audit supersedes it", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-edgeretire-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-edgeretire", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    // Iteration 1 plans a task that implements nothing the graph knows, so
    // its requirement keeps a traceability gap; iteration 2 wires it.
    const requirementIds: string[] = [];
    const planTasks: PlanTasksPort = ({ requirements, impactPaths, gateIds }) => {
      const requirementId = requirements[0]?.id ?? "requirement_none";
      requirementIds.push(requirementId);
      const first = requirementIds.length === 1;
      return [
        {
          id: first ? "task_unwired" : "task_wiring",
          objective: first ? "unwired work" : "wire the legacy requirement",
          impact_paths: impactPaths.map((path) => [...path]),
          expected_outputs: first
            ? ["requirement_nonexistent"]
            : [requirementId, ...requirementIds.slice(0, -1)],
          capabilities: [],
          tools: [],
          dependencies: [],
          risk: "low",
          budget: { steps: 30, tokens: 120000 },
          acceptance: [{ description: "work done", verification: "mandatory gate suite passes" }],
          required_gates: [...gateIds],
        },
      ];
    };
    const deps = makeDeps(projectRoot, newId, {
      execute: recordingExecutor().executor,
      planTasks,
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

    const first = await driveToCompletion(INTENT, bootstrapped.value.iterationId);
    expect(first.status).toBe("blocked");
    if (first.status !== "blocked") return;
    const findingsRoot = join(projectRoot, ".harness", "artifacts", "findings");
    const gapFinding = readdirSync(findingsRoot)
      .filter((entry) => entry.startsWith("finding_audit-traceability-gap-"))
      .at(-1);
    expect(gapFinding).toBeDefined();
    if (gapFinding === undefined) return;
    const blocksEdgeId = `edge_${sha256Hex(`BLOCKS:${gapFinding}:${first.iterationId}`).slice(0, 16)}`;

    const requirementId = `requirement_${sha256Hex(INTENT).slice(0, 16)}`;
    const editDeps = { projectRoot, readBaseline: () => headOf(projectRoot) };
    const repair = await proposeGraphEdge(editDeps, {
      type: "IMPLEMENTS",
      sourceId: "task_unwired",
      targetId: requirementId,
      actor: "human:local",
    });
    await approveGraphEdge(editDeps, {
      edgeId: repair.edgeId,
      previewDigest: repair.previewDigest,
      actor: "human:local",
    });
    const repaired = await resumeIteration(deps, first.workflowOperationId, undefined);
    expect(repaired.status).toBe("completed");

    // The finding is superseded and its BLOCKS edge retired with it.
    const findingNodeDirectory = join(
      projectRoot,
      ".harness",
      "artifacts",
      "finding-nodes",
      gapFinding,
    );
    expect(readdirSync(findingNodeDirectory).sort()).toEqual(["1.json", "2.json"]);
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
      const retired = edges.find((edge) => edge.id === blocksEdgeId);
      expect(retired?.status).toBe("superseded");
      // The retired edge participates in nothing: no traceability gap, no
      // stale-knowledge flag for it, no status blocker.
      const report = auditGraph({ nodes, edges });
      expect(report.findings.some((finding) => finding.kind === "traceability_gap")).toBe(false);
      expect(
        report.findings.some(
          (finding) =>
            finding.kind === "stale_knowledge" && finding.subjects.includes(blocksEdgeId),
        ),
      ).toBe(false);
    } finally {
      database.close();
    }
    // Both sides of the repaired traceability relation are now clean.
    const blockers = collectProjectStatus(projectRoot).blockers;
    expect(blockers.some((blocker) => blocker.includes("traceability-gap"))).toBe(false);
    expect(blockers).toEqual([]);
  });

  it("drives findings through accept, supersede and close with ledger-backed transitions", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-finding-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-finding", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const planTasks: PlanTasksPort = ({ impactPaths, gateIds }) => [
      {
        id: "task_unwired",
        objective: "unwired work",
        impact_paths: impactPaths.map((path) => [...path]),
        expected_outputs: ["requirement_nonexistent"],
        capabilities: [],
        tools: [],
        dependencies: [],
        risk: "low",
        budget: { steps: 30, tokens: 120000 },
        acceptance: [{ description: "work done", verification: "mandatory gate suite passes" }],
        required_gates: [...gateIds],
      },
    ];
    const deps = makeDeps(projectRoot, newId, {
      execute: recordingExecutor().executor,
      planTasks,
    });

    let outcome = await runIteration(deps, {
      intent: INTENT,
      iterationId: bootstrapped.value.iterationId,
    });
    while (outcome.status === "approval_required") {
      outcome = await approveAndResume(deps, outcome);
    }
    expect(outcome.status).toBe("blocked");

    const findingsRoot = join(projectRoot, ".harness", "artifacts", "findings");
    const designFinding = readdirSync(findingsRoot).find((entry) =>
      entry.startsWith("finding_audit-missing-design-artifact-"),
    ) as string;
    const orphanFinding = readdirSync(findingsRoot).find((entry) =>
      entry.startsWith("finding_audit-task-orphan-"),
    ) as string;
    expect(designFinding).toBeDefined();
    expect(orphanFinding).toBeDefined();
    const statusBefore = collectProjectStatus(projectRoot);
    expect(statusBefore.warnings).toContain(`warning finding ${designFinding}`);
    expect(statusBefore.blockers).toContain(`blocking finding ${orphanFinding}`);

    // accept: feedback resealed accepted, node revision accepted, warning stays.
    const accepted = await resolveFinding(deps, {
      findingId: designFinding,
      action: "accept",
      actor: "human:local",
    });
    expect(accepted.status).toBe("accepted");
    expect(existsSync(join(findingsRoot, designFinding, "accepted.json"))).toBe(true);
    expect(collectProjectStatus(projectRoot).warnings).toContain(
      `warning finding ${designFinding}`,
    );

    // supersede: node superseded, warning drops out.
    const superseded = await resolveFinding(deps, {
      findingId: designFinding,
      action: "supersede",
      actor: "human:local",
    });
    expect(superseded.status).toBe("superseded");
    expect(collectProjectStatus(projectRoot).warnings).not.toContain(
      `warning finding ${designFinding}`,
    );

    // close requires current passing repair evidence and retires the BLOCKS edge.
    await expect(
      resolveFinding(deps, { findingId: orphanFinding, action: "close", actor: "human:local" }),
    ).rejects.toThrow(/requires --evidence/u);
    await expect(
      resolveFinding(deps, {
        findingId: orphanFinding,
        action: "close",
        actor: "human:local",
        evidenceId: "evidence_nonexistent",
      }),
    ).rejects.toThrow(/unknown or unusable repair evidence/u);
    const closed = await resolveFinding(deps, {
      findingId: orphanFinding,
      action: "close",
      actor: "human:local",
      evidenceId: "evidence_ledger_integrity",
    });
    expect(closed.status).toBe("closed");
    const closedRecord = JSON.parse(
      readFileSync(join(findingsRoot, orphanFinding, "closed.json"), "utf8"),
    ) as { status: string; extensions: { "harness.closure": { evidence_id: string } } };
    expect(closedRecord.extensions["harness.closure"].evidence_id).toBe(
      "evidence_ledger_integrity",
    );
    const statusAfter = collectProjectStatus(projectRoot);
    expect(statusAfter.blockers).not.toContain(`blocking finding ${orphanFinding}`);
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
      const blocks = edges.filter(
        (edge) => edge.type === "BLOCKS" && edge.source_id === orphanFinding,
      );
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.every((edge) => edge.status === "superseded")).toBe(true);
    } finally {
      database.close();
    }

    // Resolved findings refuse further transitions.
    await expect(
      resolveFinding(deps, { findingId: orphanFinding, action: "accept", actor: "human:local" }),
    ).rejects.toThrow(/already resolved/u);
    await expect(
      resolveFinding(deps, { findingId: "finding_nope", action: "accept", actor: "human:local" }),
    ).rejects.toThrow(/unknown finding/u);
  });

  it("stages and commits a human-proposed edge with digest-bound approval", async () => {
    const newId = sequentialIds();
    const parent = makeTempDir("harness-orch-edge-");
    const bootstrapped = await createNewProject(
      { parentDirectory: parent, name: "orch-edge", intent: INTENT },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId: (kind) => newId(kind) },
    );
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.message);
    const projectRoot = bootstrapped.value.projectRoot;
    const planTasks: PlanTasksPort = ({ impactPaths, gateIds }) => [
      {
        id: "task_unwired",
        objective: "unwired work",
        impact_paths: impactPaths.map((path) => [...path]),
        expected_outputs: ["requirement_nonexistent"],
        capabilities: [],
        tools: [],
        dependencies: [],
        risk: "low",
        budget: { steps: 30, tokens: 120000 },
        acceptance: [{ description: "work done", verification: "mandatory gate suite passes" }],
        required_gates: [...gateIds],
      },
    ];
    const deps = makeDeps(projectRoot, newId, {
      execute: recordingExecutor().executor,
      planTasks,
    });
    let outcome = await runIteration(deps, {
      intent: INTENT,
      iterationId: bootstrapped.value.iterationId,
    });
    while (outcome.status === "approval_required") {
      outcome = await approveAndResume(deps, outcome);
    }
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    const blockedWorkflowOperationId = outcome.workflowOperationId;

    const requirementId = `requirement_${sha256Hex(INTENT).slice(0, 16)}`;
    const editDeps = { projectRoot, readBaseline: () => headOf(projectRoot) };

    // Invalid relation and unknown endpoints are typed errors.
    await expect(
      proposeGraphEdge(editDeps, {
        type: "IMPLEMENTS",
        sourceId: requirementId,
        targetId: "task_unwired",
        actor: "human:local",
      }),
    ).rejects.toThrow(/not compatible/u);
    await expect(
      proposeGraphEdge(editDeps, {
        type: "IMPLEMENTS",
        sourceId: "task_unwired",
        targetId: "requirement_nope",
        actor: "human:local",
      }),
    ).rejects.toThrow(/unknown edge endpoint/u);

    // Stage, then re-stage: same digest, single proposal artifact.
    const staged = await proposeGraphEdge(editDeps, {
      type: "IMPLEMENTS",
      sourceId: "task_unwired",
      targetId: requirementId,
      actor: "human:local",
    });
    expect(staged.status).toBe("staged");
    const restaged = await proposeGraphEdge(editDeps, {
      type: "IMPLEMENTS",
      sourceId: "task_unwired",
      targetId: requirementId,
      actor: "human:local",
    });
    expect(restaged.previewDigest).toBe(staged.previewDigest);

    // Approval must bind the exact staged digest.
    await expect(
      approveGraphEdge(editDeps, {
        edgeId: staged.edgeId,
        previewDigest: "0".repeat(64),
        actor: "human:local",
      }),
    ).rejects.toThrow(/does not bind/u);
    const approved = await approveGraphEdge(editDeps, {
      edgeId: staged.edgeId,
      previewDigest: staged.previewDigest,
      actor: "human:local",
    });
    expect(approved.status).toBe("committed");
    const again = await approveGraphEdge(editDeps, {
      edgeId: staged.edgeId,
      previewDigest: staged.previewDigest,
      actor: "human:local",
    });
    expect(again.status).toBe("already_present");

    // The committed edge is active in the graph and clears the orphan gap.
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
      const edge = edges.find((candidate) => candidate.id === staged.edgeId);
      expect(edge?.status).toBe("accepted");
      expect(edge?.source).toBe("human");
      const report = auditGraph({ nodes, edges });
      expect(
        report.findings.some(
          (finding) => finding.kind === "task_orphan" && finding.subjects.includes("task_unwired"),
        ),
      ).toBe(false);
    } finally {
      database.close();
    }

    const completed = await resumeIteration(deps, blockedWorkflowOperationId, undefined);
    expect(completed.status).toBe("completed");
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
    // The plain path never invents options.
    for (const question of outcome.questions) {
      expect(question.options).toBeUndefined();
    }
    expect(findOpenWorkflowOperation(projectRoot, () => headOf(projectRoot))).toBeUndefined();
  });

  it("surfaces optioned clarification questions from the interpreter, deterministically", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-clarify", newId);
    const deps = makeDeps(projectRoot, newId, {
      interpret: (intent) =>
        intent.includes("ambiguous")
          ? {
              clarification: [
                {
                  subject: "intent" as const,
                  question: "which delivery channel should the change target?",
                  options: [" SSE push ", "polling", "other", "polling"],
                },
                {
                  subject: "requirement" as const,
                  question: "which data store backs the feature?",
                  options: ["sqlite", "postgres"],
                },
              ],
            }
          : undefined,
    });

    const first = await runIteration(deps, { intent: "an ambiguous change" });
    expect(first.status).toBe("input_required");
    if (first.status !== "input_required") return;
    expect(first.questions).toHaveLength(2);
    for (const question of first.questions) {
      expect(question.options?.length).toBeGreaterThanOrEqual(3);
      expect(question.options?.length).toBeLessThanOrEqual(5);
      expect(question.options?.at(-1)).toBe("other");
    }
    // Options are trimmed, de-duplicated and keep the interpreter's order.
    expect(first.questions[0]?.options).toEqual(["SSE push", "polling", "other"]);
    expect(first.questions[1]?.options).toEqual(["sqlite", "postgres", "other"]);

    // Identical intent, byte-identical questions.
    const second = await runIteration(deps, { intent: "an ambiguous change" });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // A malformed offer is a port error, never silently completed.
    const broken = makeDeps(projectRoot, newId, {
      interpret: () => ({
        clarification: [
          { subject: "intent" as const, question: "pick one", options: ["only-choice"] },
        ],
      }),
    });
    await expect(runIteration(broken, { intent: "an ambiguous change" })).rejects.toThrow(
      /2-4 options/u,
    );

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

  it("records an accepted evaluation for a terminal failed run before blocking", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-terminal-failure", newId);
    const fake = recordingExecutor((envelope) => ({
      ...claimedResult(envelope, "credential failure"),
      outcome: "failed",
      termination_reason: "adapter_failure",
      completion_claimed: false,
      summary: "provider credential is missing",
    }));
    const deps = makeDeps(projectRoot, newId, { execute: fake.executor });

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    outcome = await approveAndResume(deps, outcome);
    outcome = await approveAndResume(deps, outcome);

    expect(outcome.status).toBe("blocked");
    expect(collectProjectStatus(projectRoot).evaluation_coverage).toEqual({
      evaluated: 1,
      total: 1,
    });
  });

  it("clears a task-owned run failure blocker after a successful retry", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-retry-blocker", newId);
    const fake = recordingExecutor((envelope, call) =>
      call === 1
        ? {
            ...claimedResult(envelope, "first attempt"),
            outcome: "failed",
            termination_reason: "adapter_failure",
            completion_claimed: false,
            summary: "provider credential is missing",
          }
        : claimedResult(envelope, "retry succeeded"),
    );
    const deps = makeDeps(projectRoot, newId, { execute: fake.executor });

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    outcome = await approveAndResume(deps, outcome);
    outcome = await approveAndResume(deps, outcome);
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;

    outcome = await resumeIteration(deps, outcome.workflowOperationId, undefined);

    expect(outcome.status).toBe("completed");
    expect(collectProjectStatus(projectRoot).blockers).toEqual([]);
  });

  it("blocks completion when the post-evaluation audit finds a blocking gap", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-audit-before-complete", newId);
    const defaultEvaluate = createDefaultEvaluationPort();
    const deps = makeDeps(projectRoot, newId, {
      execute: recordingExecutor().executor,
      evaluate: (input) => {
        mkdirSync(join(projectRoot, "test"), { recursive: true });
        writeFileSync(join(projectRoot, "test", "late.test.ts"), "export {};\n", "utf8");
        return defaultEvaluate(input);
      },
    });

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    outcome = await approveAndResume(deps, outcome);
    outcome = await approveAndResume(deps, outcome);

    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    const blockedSnapshot = JSON.parse(
      readFileSync(
        join(projectRoot, ".harness", "artifacts", "snapshots", `${outcome.snapshotId}.json`),
        "utf8",
      ),
    ) as SnapshotRecord;
    expect(blockedSnapshot.status).toBe("blocked");
    const iterationRevisions = readdirSync(
      join(projectRoot, ".harness", "artifacts", "iterations", outcome.iterationId),
    ).sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
    const iteration = JSON.parse(
      readFileSync(
        join(
          projectRoot,
          ".harness",
          "artifacts",
          "iterations",
          outcome.iterationId,
          iterationRevisions.at(-1) as string,
        ),
        "utf8",
      ),
    ) as { iteration_state: string };
    expect(iteration.iteration_state).toBe("blocked");
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

  it("streams phase progress through the onPhaseProgress observer without touching the ledger", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("orch-phase-progress", newId);
    const events: PhaseProgressEvent[] = [];
    const deps = makeDeps(projectRoot, newId, {
      onPhaseProgress: (event) => events.push(event),
    });

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    expect(outcome.status).toBe("approval_required");
    const firstPause = events.find((event) => event.type === "phase_paused");
    expect(firstPause?.paused_status).toBe("approval_required");

    outcome = await approveAndResume(deps, outcome);
    outcome = await approveAndResume(deps, outcome);
    if (outcome.status !== "completed") throw new Error("expected completion");

    const timeline = events.map((event) => `${event.type}:${event.phase}`);
    for (const phase of ORCHESTRATION_PHASES) {
      expect(timeline).toContain(`phase_started:${phase}`);
      expect(timeline).toContain(`phase_completed:${phase}`);
    }
    expect(timeline.at(-1)).toBe("phase_completed:snapshot");
    // Structural invariant: every started phase settles (completed or paused)
    // before the next one starts.
    const started = events.filter((event) => event.type === "phase_started");
    const settled = events.filter((event) => event.type !== "phase_started");
    expect(started).toHaveLength(settled.length);
    for (const event of events) {
      expect(event.workflow_operation_id).toBe(outcome.workflowOperationId);
      expect(event.iteration_id).toBe(outcome.iterationId);
      expect(event.timestamp).toBe(FIXED_NOW);
    }
  });
});
