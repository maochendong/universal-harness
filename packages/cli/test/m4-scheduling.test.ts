import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessRunResult } from "@universal-harness-internal/adapter-agent-command";
import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  appendProjectContextBundleRecord,
  compileCapabilityPlan,
  contentDigest,
  createCaptureAcceptanceStageHandler,
  createCaptureProposalStageHandlers,
  createCaptureReviewStageHandlers,
  createCaptureRiskStageHandlers,
  createInMemoryPrdProposalAdapter,
  createInMemoryPrdReviewAdapter,
  createPrdCaptureCoordinator,
  createProfileDecisionRecord,
  createProjectContextBundleRecord,
  createProjectProfileRecord,
  harnessRootFor,
  readCommittedOperations,
  readManagedManifest,
  type CapabilityPlanRecord,
  type CaptureSessionRecord,
  type CaptureStageRequest,
  type FeedbackRecord,
  type LifecycleEvent,
  type PrdProposalDraft,
  type PrdReviewReportDraft,
  type PrdReviewRubric,
} from "@universal-harness-internal/core";
import type { AgentTaskEnvelope } from "@universal-harness-internal/plugin-sdk";
import {
  createDirectExecutor,
  createNewProject,
  createProjectSchedulerHost,
  readApprovalRequests,
  readBridgedCaptureApprovalDecision,
  readCurrentOperation,
  resolveApproval,
  runIteration,
  type CaptureCoordinatorSeam,
  type ExecutionPlanContent,
  type OrchestratorDependencies,
  type ParallelTaskExecutionOutcome,
  type ParallelTaskExecutionPort,
  type ProjectSchedulerHost,
  type SchedulerReadModel,
} from "@universal-harness-internal/runtime";

import {
  EXIT_CODES,
  createStubRuntimeService,
  runCli,
  type CliIo,
  type CommandResult,
  type ResumeRequest,
  type RunRequest,
} from "../src/index.js";
import { formatEventLine } from "../src/commands/watch.js";
import { createProjectAgentSlotFactory, supervisedSingleSlotNotice } from "../src/project-agent.js";
import {
  PROJECT_RUNTIME_CONFIG_PATH,
  readProjectRuntimeConfig,
} from "../src/project-runtime-config.js";
import { createRuntimeConfigurationService } from "../src/runtime/configuration-service.js";
import {
  createOrchestratedRuntimeService,
  presentExecutionPlan,
  resolveSchedulerConcurrency,
  type SchedulerHostRequest,
} from "../src/runtime-service.js";

interface Captured {
  readonly io: CliIo;
  stdout(): string;
  stderr(): string;
}

function captureIo(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeStdout: (text) => out.push(text),
      writeStderr: (text) => err.push(text),
      isInteractive: false,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** Minimal managed-project marker so `requireProjectRoot` resolves. */
function makeProject(): string {
  const root = tempRoot("harness-cli-m4-");
  mkdirSync(join(root, ".harness"), { recursive: true });
  writeFileSync(
    join(root, ".harness", "manifest.yaml"),
    `${JSON.stringify({
      manifest_version: 1,
      name: "m4-demo",
      repository_id: "repository_m4",
      created_at: "2026-08-31T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("runtime.json agent_pool.slots (M4 design 10.2)", () => {
  it("reads the requested local slot count", () => {
    const projectRoot = makeProject();
    writeFileSync(
      join(projectRoot, PROJECT_RUNTIME_CONFIG_PATH),
      `${JSON.stringify({ runtime_config_version: 3, agent_pool: { slots: 4 }, gates: [], judge_gates: [] })}\n`,
      "utf8",
    );
    const config = readProjectRuntimeConfig(projectRoot);
    expect(config.agent_pool).toEqual({ slots: 4 });
  });

  it("rejects a non-positive slot request", () => {
    const projectRoot = makeProject();
    writeFileSync(
      join(projectRoot, PROJECT_RUNTIME_CONFIG_PATH),
      `${JSON.stringify({ runtime_config_version: 3, agent_pool: { slots: 0 }, gates: [], judge_gates: [] })}\n`,
      "utf8",
    );
    expect(() => readProjectRuntimeConfig(projectRoot)).toThrow(/agent_pool\.slots/u);
  });

  it("keeps projects without agent_pool untouched", () => {
    const projectRoot = makeProject();
    const config = readProjectRuntimeConfig(projectRoot);
    expect(config.agent_pool).toBeUndefined();
  });
});

describe("--max-concurrency argument (M4 design 20)", () => {
  function capturingRuntime(requests: { run: RunRequest[]; resume: ResumeRequest[] }) {
    const stub = createStubRuntimeService();
    return {
      ...stub,
      run: (request: RunRequest): Promise<CommandResult> => {
        requests.run.push(request);
        return Promise.resolve({
          command: "run",
          status: "ok" as const,
          message: "captured",
          data: {},
        });
      },
      resume: (request: ResumeRequest): Promise<CommandResult> => {
        requests.resume.push(request);
        return Promise.resolve({
          command: "resume",
          status: "ok" as const,
          message: "captured",
          data: {},
        });
      },
    };
  }

  it("parses a positive integer for run and resume", async () => {
    const requests = { run: [] as RunRequest[], resume: [] as ResumeRequest[] };
    const runtime = capturingRuntime(requests);
    const projectRoot = makeProject();

    const runCaptured = captureIo();
    expect(
      await runCli(["run", "--max-concurrency", "3", "--json"], {
        io: runCaptured.io,
        cwd: projectRoot,
        runtime,
      }),
    ).toBe(EXIT_CODES.ok);
    expect(requests.run[0]?.maxConcurrency).toBe(3);

    const resumeCaptured = captureIo();
    expect(
      await runCli(["resume", "workflow_x", "--max-concurrency", "2", "--json"], {
        io: resumeCaptured.io,
        cwd: projectRoot,
        runtime,
      }),
    ).toBe(EXIT_CODES.ok);
    expect(requests.resume[0]?.maxConcurrency).toBe(2);
  });

  it("rejects zero and non-integer values before any drive", async () => {
    const requests = { run: [] as RunRequest[], resume: [] as ResumeRequest[] };
    const runtime = capturingRuntime(requests);
    const projectRoot = makeProject();

    for (const args of [
      ["run", "--max-concurrency", "0"],
      ["run", "--max-concurrency=-2"],
      ["run", "--max-concurrency", "1.5"],
      ["resume", "workflow_x", "--max-concurrency", "0"],
    ]) {
      const captured = captureIo();
      expect(await runCli(args, { io: captured.io, cwd: projectRoot, runtime })).toBe(
        EXIT_CODES.usage,
      );
      expect(captured.stderr()).toMatch(/positive integer/u);
    }
    expect(requests.run).toHaveLength(0);
    expect(requests.resume).toHaveLength(0);
  });
});

describe("resolveSchedulerConcurrency (the local value is a request, never authority)", () => {
  const ceilings = {
    profile_limit: 2,
    installation_limit: 8,
    project_limit: 2,
    local_resource_limit: 8,
  } as const;

  it("clamps a request above the policy ceiling instead of expanding it", () => {
    const decision = resolveSchedulerConcurrency({ requested: 8, ceilings });
    expect(decision.effective).toBe(2);
    expect(decision.requested).toBe(8);
    expect(decision.policy_proposal_required).toBe(true);
  });

  it("decreases need no approval", () => {
    const decision = resolveSchedulerConcurrency({ requested: 1, ceilings });
    expect(decision.effective).toBe(1);
    expect(decision.policy_proposal_required).toBe(false);
  });

  it("a request within every ceiling stands as-is", () => {
    const decision = resolveSchedulerConcurrency({ requested: 2, ceilings });
    expect(decision.effective).toBe(2);
    expect(decision.policy_proposal_required).toBe(false);
  });

  it("never drops below a single slot", () => {
    const decision = resolveSchedulerConcurrency({
      requested: 1,
      ceilings: {
        profile_limit: 0,
        installation_limit: 0,
        project_limit: 0,
        local_resource_limit: 0,
      },
    });
    expect(decision.effective).toBe(1);
  });
});

describe("createProjectAgentSlotFactory (M4 plan Task 12 step 2)", () => {
  const AGENT_CONFIG = {
    provider: "dsh" as const,
    expected_version: "9.9.9",
    executable: "dsh-fake",
    launcher_args: ["headless"],
    env_allowlist: ["HOME", "PATH"],
    allowed_read_paths: ["src"],
    proposed_write_paths: ["src"],
  };

  function envelope(taskId: string): AgentTaskEnvelope {
    return {
      task_id: taskId,
      plan_id: "plan_m4",
      iteration_id: "iteration_m4",
      repository_id: "repository_m4",
      objective: "exercise the slot factory",
      expected_output: "a file",
      acceptance_criteria: ["works"],
      required_gate_ids: [],
      allowed_read_paths: ["src"],
      proposed_write_paths: ["src"],
      state_proposal_fields: [],
      baseline_commit: "0".repeat(40),
      input_digest: "1".repeat(64),
      digest: "2".repeat(64),
      loop_policy: { max_steps: 4, max_tokens: 1000, max_duration_ms: 60_000 },
    };
  }

  function okProcess(stdout: string): ProcessRunResult {
    return {
      exit_code: 0,
      signal: null,
      stdout,
      stderr: "",
      timed_out: false,
      output_truncated: false,
      aborted: false,
      duration_ms: 1,
    };
  }

  it("builds a fresh adapter per slot call, bound to that worktree and evidence dir", async () => {
    const projectRoot = makeProject();
    const worktreeA = join(projectRoot, "wt-a");
    const worktreeB = join(projectRoot, "wt-b");
    const evidenceA = join(projectRoot, "evidence", "a");
    const evidenceB = join(projectRoot, "evidence", "b");
    mkdirSync(worktreeA, { recursive: true });
    mkdirSync(worktreeB, { recursive: true });

    const calls: { readonly executable: string; readonly cwd: string; readonly args: string[] }[] =
      [];
    const factory = createProjectAgentSlotFactory({
      projectRoot,
      config: AGENT_CONFIG,
      inspector: {
        inspect: (root) =>
          Promise.resolve({
            head: "0".repeat(40),
            changed_paths: [],
            digest: `digest-${root}`,
          }),
      },
      spawnProcess: (executable, options) => {
        calls.push({ executable, cwd: options.cwd, args: [...options.args] });
        return Promise.resolve(
          okProcess(options.args.includes("--version") ? AGENT_CONFIG.expected_version : "done"),
        );
      },
    });

    expect(factory.manifest.provider).toBe("dsh");
    expect(factory.adapter_manifest_digest).toMatch(/^[a-f0-9]{64}$/u);

    const slotA = factory.create({
      slot_id: "slot-1",
      worktree_root: worktreeA,
      evidence_dir: evidenceA,
    });
    const slotA2 = factory.create({
      slot_id: "slot-1",
      worktree_root: worktreeA,
      evidence_dir: evidenceA,
    });
    const slotB = factory.create({
      slot_id: "slot-2",
      worktree_root: worktreeB,
      evidence_dir: evidenceB,
    });
    // No caching: every invocation returns a new adapter with its own probe state.
    expect(slotA).not.toBe(slotA2);
    expect(slotA).not.toBe(slotB);

    const resultA = await slotA.run(envelope("task_a"), { mode: "supervised" });
    const resultB = await slotB.run(envelope("task_b"), { mode: "supervised" });
    expect(resultA.outcome).toBe("handoff");
    expect(resultB.outcome).toBe("handoff");

    // Each adapter ran its provider process inside its own worktree.
    expect(calls.some((call) => call.cwd === worktreeA)).toBe(true);
    expect(calls.some((call) => call.cwd === worktreeB)).toBe(true);
    expect(calls.every((call) => call.executable === AGENT_CONFIG.executable)).toBe(true);
    // Each fresh adapter re-probed the provider contract (no shared probe state).
    expect(
      calls.filter((call) => call.cwd === worktreeA && call.args.includes("--version")),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.cwd === worktreeB && call.args.includes("--version")),
    ).toHaveLength(1);
    // Run-scoped evidence directories received the transcripts.
    expect(existsSync(join(evidenceA, "transcript-task_a.json"))).toBe(true);
    expect(existsSync(join(evidenceB, "transcript-task_b.json"))).toBe(true);
  });

  it("surfaces supervised single-slot mode for an unattended-ineligible manifest", () => {
    const projectRoot = makeProject();
    const factory = createProjectAgentSlotFactory({ projectRoot, config: AGENT_CONFIG });
    const notice = supervisedSingleSlotNotice(factory.manifest);
    // The dsh manifest is delegated without metering/interception: it is never
    // unattended-eligible, so the run degrades to one supervised slot.
    expect(notice).toMatch(/监督/u);
    expect(notice).toMatch(/单槽/u);
  });

  it("returns no notice for an unattended-eligible managed manifest", () => {
    expect(
      supervisedSingleSlotNotice({
        provider: "managed-stub",
        control: "managed",
        trajectory_visibility: "full",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "explicit",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M4 Task 12 command-behavior tests: the CLI drives local task waves through
// the Project Scheduler Host binding and inspects them through status, watch,
// plan, abort and serve. The fixture drives a real project to the capture
// approval at the runtime layer (mirroring the kernel parallel-execute
// fixture), then hands the open operation to the CLI service with an injected
// scheduler host. The kernel owns wave generation; these tests pin the CLI
// wiring: Driver Lock discipline, stream separation and the read surfaces.
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-08-31T00:00:00.000Z";
const INTENT = "add the first capability";
const CAPTURE_POLICY_DIGEST = "9".repeat(64);

function headOf(projectRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
}

function sequentialIds(): (kind: string) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_${String(next).padStart(4, "0")}`;
  };
}

const REVIEW_RUBRIC: PrdReviewRubric = {
  rubric_id: "capture-review-rubric",
  dimensions: [
    { dimension_id: "clarity", prompt: "Is every requirement unambiguous?" },
    { dimension_id: "completeness", prompt: "Does the PRD cover the intent?" },
    { dimension_id: "testability", prompt: "Is every criterion observable?" },
  ],
  mandatory_dimension_ids: ["clarity", "completeness", "testability"],
};

/** A draft that passes every hard gate: one must-change requirement, one atomic criterion. */
function validDraft(session: CaptureSessionRecord): PrdProposalDraft {
  const binding = {
    source_kind: "intent" as const,
    source_id: "intent",
    source_digest: session.intent_digest,
  };
  return {
    schema_version: "1.1.0",
    intent: { text: session.intent_text, digest: session.intent_digest },
    problem_statement: "Users cannot archive monthly reports outside the application.",
    goals: [
      {
        draft_key: "goal-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "Users can export the monthly report as a CSV file.",
      },
    ],
    non_goals: [],
    actors: [],
    scenarios: [],
    requirements: [
      {
        draft_key: "req-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "The user can export the monthly report as a CSV file.",
        priority: "must",
        change_kind: "must_change",
        scenario_ids: [],
        acceptance_criterion_ids: ["criterion-1"],
      },
    ],
    constraints: [],
    acceptance_criteria: [
      {
        draft_key: "criterion-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        requirement_id: "req-1",
        precondition: "a monthly report exists for the user",
        action: "the user exports the report as CSV",
        observable_outcome: "a CSV file containing the report rows is produced",
        verification_intent: "compare the exported CSV rows with the report data",
        test_first_example:
          "given an existing report, exporting produces a CSV whose rows match the report",
        scenario_kind: "primary",
      },
    ],
    assumptions: [],
    dependencies: [],
    risks: [],
    open_questions: [],
    glossary: [],
    context_source_refs: [],
  };
}

function acceptDraft(): PrdReviewReportDraft {
  return {
    verdict: "accept",
    dimensions: REVIEW_RUBRIC.dimensions.map((dimension) => ({
      dimension_id: dimension.dimension_id,
      status: "satisfied" as const,
      notes: "ok",
    })),
    findings: [],
    suggested_questions: [],
  };
}

/**
 * Local copy of the runtime's coordinated-capture fixture: a capture seam
 * whose coordinator drives a session to the human approval route with the
 * real proposal/review/risk/acceptance stages and in-memory model adapters.
 */
function captureSeamForTest(projectRoot: string): CaptureCoordinatorSeam {
  const proposalStages = createCaptureProposalStageHandlers({
    projectRoot,
    proposal: createInMemoryPrdProposalAdapter((input) => ({
      status: "proposed" as const,
      draft: validDraft(input.session),
    })),
    adapter_profile: {
      backing: "in_memory",
      adapter_profile_digest: "e".repeat(64),
      prompt_version_digest: "f".repeat(64),
      producer_identity: "in-memory-proposal",
    },
  });
  const reviewStages = createCaptureReviewStageHandlers({
    projectRoot,
    review: createInMemoryPrdReviewAdapter(() => ({
      status: "completed" as const,
      report: acceptDraft(),
    })),
    rubric: REVIEW_RUBRIC,
    adapter_profile: {
      backing: "in_memory",
      adapter_profile_digest: "7".repeat(64),
      prompt_version_digest: "8".repeat(64),
      reviewer_identity: "in-memory-review",
    },
  });
  const risk = createCaptureRiskStageHandlers({
    projectRoot,
    policy: {
      project_id: `project_${readManagedManifest(projectRoot).name}`,
      profile_id: "standard",
      allow_policy_auto_approval: false,
      policy_actor: "policy:capture-standard@1",
    },
    policy_digest: CAPTURE_POLICY_DIGEST,
  });
  const accept = createCaptureAcceptanceStageHandler({
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    policy_digest: CAPTURE_POLICY_DIGEST,
    now: () => FIXED_NOW,
  });
  const compileContext = (request: CaptureStageRequest) => {
    const purpose = request.invocation?.purpose === "context_review" ? "review" : "proposal";
    const bundle = createProjectContextBundleRecord({
      session_id: request.session.session_id,
      purpose,
      project_baseline_digest: request.session.project_baseline_digest,
      profile_digest: request.session.project_profile_digest,
      policy_digest: request.session.capture_policy_digest,
      budget: {
        max_files: 10,
        max_bytes_per_source: 4096,
        max_total_bytes: 16384,
        max_summary_chars: 500,
      },
      sources: [],
      exclusions: [],
    });
    appendProjectContextBundleRecord(projectRoot, bundle);
    return { kind: "context_compiled" as const, bundle_digest: bundle.content_digest };
  };
  return {
    coordinator: createPrdCaptureCoordinator({
      projectRoot,
      handlers: {
        compileContext,
        propose: proposalStages.propose,
        validate: proposalStages.validate,
        review: reviewStages.review,
        assessRisk: risk.assessRisk,
        accept,
      },
      readApprovalDecision: (requestId, decisionId) =>
        readBridgedCaptureApprovalDecision(projectRoot, requestId, decisionId),
    }),
    session_context: {
      project_profile_digest: "a".repeat(64),
      profile_decision_digest: "b".repeat(64),
      capture_policy_digest: "c".repeat(64),
      project_baseline_digest: "d".repeat(64),
    },
  };
}

/**
 * A real Protocol 1.3 compile over the Lite profile with the parallel module
 * policy-required, bound to the operation the first drive minted (the kernel
 * parallel-execute fixture's routing authority, re-implemented here).
 */
function compileParallelPlanForTest(operationId: string): CapabilityPlanRecord {
  const profile = createProjectProfileRecord({
    project_id: "project_m4-cli-parallel",
    revision: 1,
    profile_id: "lite",
    policy_digest: CAPTURE_POLICY_DIGEST,
    actor: "human:test",
    effective_from: FIXED_NOW,
  });
  const decision = createProfileDecisionRecord({
    decision_kind: "project_profile_change",
    project_id: "project_m4-cli-parallel",
    actor: "human:test",
    idempotency_key: `profile-decision:m4-cli:${operationId}`,
    current_profile_id: "lite",
    decided_profile_id: "lite",
    policy_digest: CAPTURE_POLICY_DIGEST,
    decided_at: FIXED_NOW,
  });
  return compileCapabilityPlan({
    operation_id: operationId,
    stage: "final",
    protocol_version: "1.3.0",
    project_profile: profile,
    profile_decision: decision,
    requirement_digest: "b".repeat(64),
    risk_digest: "c".repeat(64),
    policy_digest: CAPTURE_POLICY_DIGEST,
    baseline_digest: "d".repeat(64),
    policy: { required_capabilities: ["parallel_task_execution"] },
    providers: ["isolated_workspace_provider", "structured_gate_provider"],
  }) as CapabilityPlanRecord;
}

interface ParallelHarness {
  readonly parent: string;
  readonly projectRoot: string;
  readonly workflowOperationId: string;
  readonly plan: CapabilityPlanRecord;
  readonly newId: (kind: string) => string;
}

/**
 * Drive a fresh project through coordinated capture so the operation sits
 * open with its approval resolved, ready for the CLI to drive the execute
 * phase. The parallel CapabilityPlan binds the minted operation id, so it
 * exists only from the first drive on.
 */
async function makeParallelHarness(
  name: string,
  options: { readonly approveCapture?: boolean } = {},
): Promise<ParallelHarness> {
  const parent = tempRoot("harness-cli-m4-drive-");
  const newId = sequentialIds();
  const created = await createNewProject(
    { parentDirectory: parent, name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;
  // Persist Lite up front: the injected capture seam makes orchestratorDeps
  // assemble the capability-plan compiler, which fails closed without an
  // accepted ProjectProfile; a real CLI project has one before any capture.
  createRuntimeConfigurationService({
    actor: "human:m4-test",
    clock: () => FIXED_NOW,
  }).persistInitialProfile(projectRoot, "lite");
  const holder: { plan?: CapabilityPlanRecord } = {};
  const deps: OrchestratorDependencies = {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
    vcs: createGitVcsAdapter(),
    capture: captureSeamForTest(projectRoot),
    execution: {
      kind: "workflow",
      name: "m4-cli-test-execute",
      deterministic: true,
      execute: createDirectExecutor(),
    },
    get capabilityPlan() {
      return holder.plan;
    },
  };
  const first = await runIteration(deps, { intent: INTENT });
  if (first.status !== "approval_required") {
    throw new Error(`expected capture approval_required, got ${first.status}`);
  }
  const workflowOperationId = first.required.workflow_operation_id;
  holder.plan = compileParallelPlanForTest(workflowOperationId);
  if (options.approveCapture !== false) {
    await resolveApproval(deps, {
      requestId: first.required.request_id,
      decision: "approve",
      actor: "human:reviewer",
    });
  }
  return { parent, projectRoot, workflowOperationId, plan: holder.plan, newId };
}

type ParallelRunInput = Parameters<ParallelTaskExecutionPort["run"]>[0];
type LockHandle = Awaited<ReturnType<ProjectSchedulerHost["acquireDriverLock"]>>;

interface FakeSchedulerHost {
  readonly host: ProjectSchedulerHost;
  readonly requests: SchedulerHostRequest[];
  readonly acquired: string[];
  readonly released: string[];
  readonly runInputs: ParallelRunInput[];
  readonly modelReads: string[];
  readonly handles: LockHandle[];
  readonly cancellations: { readonly operationId: string; readonly reason: string }[];
}

/** A recording scheduler host; the deferred facade throws so run/resume tests prove the CLI acquires explicitly. */
function makeFakeSchedulerHost(input: {
  readonly model: (operationId: string) => SchedulerReadModel;
  readonly outcome: (runInput: ParallelRunInput) => ParallelTaskExecutionOutcome;
  readonly onAcquire?: (operationId: string) => LockHandle;
  readonly cancellationStatus?: "cancelled" | "unconfirmed";
}): FakeSchedulerHost {
  const fake: FakeSchedulerHost = {
    host: undefined as unknown as ProjectSchedulerHost,
    requests: [],
    acquired: [],
    released: [],
    runInputs: [],
    modelReads: [],
    handles: [],
    cancellations: [],
  };
  const host: ProjectSchedulerHost = {
    parallelExecution: {
      port: {
        run: (runInput) => {
          fake.runInputs.push(runInput);
          return Promise.resolve(input.outcome(runInput));
        },
      },
      driverLock: () => {
        throw new Error("run/resume drives must pass an explicitly acquired Driver Lock");
      },
    },
    readSchedulerModel: (operationId) => {
      fake.modelReads.push(operationId);
      return Promise.resolve(input.model(operationId));
    },
    acquireDriverLock: (operationId) => {
      fake.acquired.push(operationId);
      if (input.onAcquire !== undefined) return Promise.resolve(input.onAcquire(operationId));
      const handle: LockHandle = {
        operation_id: operationId,
        owner_token: "owner_fake_host",
        path: "/fake/driver-lock",
        release: () => {
          fake.released.push(operationId);
          return Promise.resolve();
        },
      };
      fake.handles.push(handle);
      return Promise.resolve(handle);
    },
    cancelOperation: (operationId, reason) => {
      fake.cancellations.push({ operationId, reason });
      const model = input.model(operationId);
      return Promise.resolve({
        status: input.cancellationStatus ?? "cancelled",
        operation_id: operationId,
        read_model: {
          operation_id: operationId,
          plan_digest: model.plan?.plan_digest ?? "0".repeat(64),
          projection: {
            operation_id: operationId,
            plan_digest: model.plan?.plan_digest ?? "0".repeat(64),
            baseline_commit: "0".repeat(40),
            live_state: "observed",
            observed_at: FIXED_NOW,
            slots: [],
            tasks: [],
          },
          budget: {
            limit: model.budget.limit,
            remaining: { steps: 0, tokens: 0 },
            reserved_task_ids: [],
          },
          pending_approvals: [],
          blocking_findings: [],
        },
      });
    },
    close: () => {},
  };
  (fake as { host: ProjectSchedulerHost }).host = host;
  return fake;
}

/** One blocking scheduler Finding with a typed recovery rule. */
function blockingFinding(id: string, rule: string): FeedbackRecord {
  return {
    protocol_version: "1.3.0",
    record_kind: "feedback",
    id,
    type: "Finding",
    iteration_id: "iteration_m4",
    status: "proposed",
    summary: `blocking finding ${id}`,
    created_at: FIXED_NOW,
    digest: contentDigest({ finding: id }),
    extensions: { "harness.finding": { blocking: true, rule } },
  };
}

/** A hand-made active read model: wave 0 integrated, wave 1 ready. */
function fakeSchedulerModel(
  operationId: string,
  overrides: Partial<Omit<SchedulerReadModel, "digest">> = {},
): SchedulerReadModel {
  const base = {
    capability_status: "active" as const,
    operation: {
      operation_id: operationId,
      iteration_id: "iteration_m4",
      status: "running",
      live_state: "observed" as const,
    },
    plan: {
      plan_id: "plan_m4",
      plan_digest: "a".repeat(64),
      waves: [
        { wave_index: 0, task_ids: ["task_a"] },
        { wave_index: 1, task_ids: ["task_b"] },
      ],
    },
    tasks: [
      {
        task_id: "task_a",
        title: "Task A",
        wave_index: 0,
        status: "integrated" as const,
        authority: "ledger" as const,
        dependency_ids: [],
        non_parallel_reasons: [],
      },
      {
        task_id: "task_b",
        title: "Task B",
        wave_index: 1,
        status: "ready" as const,
        authority: "ledger" as const,
        dependency_ids: ["task_a"],
        non_parallel_reasons: [],
      },
    ],
    slots: [],
    budget: {
      limit: { steps: 100, tokens: 10_000, duration_ms: 60_000 },
      consumed_steps: 10,
      consumed_tokens: 1000,
      reserved_steps: 0,
      reserved_tokens: 0,
    },
    approvals: [],
    findings: [],
    presentation_map: {},
  };
  const merged = { ...base, ...overrides };
  return { ...merged, digest: contentDigest(merged) };
}

function serviceFor(
  harness: ParallelHarness,
  fake: FakeSchedulerHost,
  io: CliIo,
  extra: { readonly onServerReady?: (server: { close(): Promise<void> }) => void } = {},
) {
  return createOrchestratedRuntimeService({
    cwd: harness.parent,
    io,
    now: () => FIXED_NOW,
    newId: harness.newId,
    execute: createDirectExecutor(),
    capture: captureSeamForTest(harness.projectRoot),
    capabilityPlan: () => harness.plan,
    schedulerHost: (request) => {
      fake.requests.push(request);
      return fake.host;
    },
    ...extra,
  });
}

const COMPLETED_OUTCOME = (runInput: ParallelRunInput): ParallelTaskExecutionOutcome => ({
  status: "completed",
  operation_id: runInput.operation_id,
  wave_integration_digests: ["1".repeat(64)],
  scheduler_state_digest: "2".repeat(64),
});

describe(
  "run/resume drive local task waves through the scheduler host (M4 Task 12)",
  { timeout: 30000 },
  () => {
    it("run takes the driver lock, drives the parallel execute node once and releases in finally", async () => {
      const harness = await makeParallelHarness("m4-drive-run");
      const fake = makeFakeSchedulerHost({
        model: (operationId) => fakeSchedulerModel(operationId),
        outcome: COMPLETED_OUTCOME,
      });
      const captured = captureIo();
      const service = serviceFor(harness, fake, captured.io);

      const result = await service.run({
        projectRoot: harness.projectRoot,
        dryRun: false,
        maxConcurrency: 8,
      });

      expect(result.status).toBe("ok");
      expect(result.message).toContain("advanced through phase execute");
      // The local value was a request: clamped to the profile ceiling of 2 and
      // flagged for a Policy Proposal, never silently expanded.
      expect(result.data["concurrency"]).toEqual({
        requested: 8,
        effective: 2,
        limited_by: "profile_limit",
        policy_proposal_required: true,
      });
      expect(fake.requests).toEqual([
        {
          projectRoot: harness.projectRoot,
          driverKind: "cli",
          maxConcurrency: 2,
          live: "write",
        },
      ]);
      // Exactly one acquire/release pair around exactly one port drive.
      expect(fake.acquired).toEqual([harness.workflowOperationId]);
      expect(fake.released).toEqual([harness.workflowOperationId]);
      expect(fake.runInputs).toHaveLength(1);
      const call = fake.runInputs[0];
      if (call === undefined) throw new Error("parallel port never ran");
      expect(call.operation_id).toBe(harness.workflowOperationId);
      expect(call.capability_plan_digest).toBe(harness.plan.record_digest);
      // The kernel received the handle the CLI acquired — not the deferred facade.
      expect(call.driver_lock).toBe(fake.handles[0]);
      // Post-drive wave progress is reported from the read model.
      expect(result.data["scheduler"]).toMatchObject({
        operation_id: harness.workflowOperationId,
        capability_status: "active",
        waves: { total: 2, integrated: 1 },
      });
      expect(captured.stderr()).toMatch(/wave 1\/2/u);
    });

    it("run --json keeps stdout to the single CommandResult line and streams progress on stderr", async () => {
      const harness = await makeParallelHarness("m4-drive-run-json");
      const fake = makeFakeSchedulerHost({
        model: (operationId) => fakeSchedulerModel(operationId),
        outcome: COMPLETED_OUTCOME,
      });
      const captured = captureIo();
      const service = serviceFor(harness, fake, captured.io);

      const exitCode = await runCli(["run", "--max-concurrency", "8", "--json"], {
        io: captured.io,
        cwd: harness.projectRoot,
        runtime: service,
      });

      expect(exitCode).toBe(EXIT_CODES.ok);
      const lines = captured.stdout().trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] ?? "") as {
        command: string;
        status: string;
        data: { concurrency: { requested: number; effective: number } };
      };
      expect(parsed.command).toBe("run");
      expect(parsed.status).toBe("ok");
      expect(parsed.data.concurrency).toMatchObject({ requested: 8, effective: 2 });
      expect(captured.stderr()).toMatch(/wave 1\/2/u);
    });

    it("resume drives under the same lock discipline", async () => {
      const harness = await makeParallelHarness("m4-drive-resume");
      const fake = makeFakeSchedulerHost({
        model: (operationId) => fakeSchedulerModel(operationId),
        outcome: (runInput) => ({
          status: "paused",
          operation_id: runInput.operation_id,
          wave_integration_digests: [],
          scheduler_state_digest: "2".repeat(64),
        }),
      });
      const captured = captureIo();
      const service = serviceFor(harness, fake, captured.io);

      const result = await service.resume({
        projectRoot: harness.projectRoot,
        workflowOperationId: harness.workflowOperationId,
        maxConcurrency: 1,
      });

      expect(result.status).toBe("blocked");
      expect(result.data["reason"]).toBe("awaiting_approval");
      expect(fake.requests).toEqual([
        {
          projectRoot: harness.projectRoot,
          driverKind: "cli",
          maxConcurrency: 1,
          live: "write",
        },
      ]);
      expect(fake.acquired).toEqual([harness.workflowOperationId]);
      expect(fake.released).toEqual([harness.workflowOperationId]);
      expect(fake.runInputs).toHaveLength(1);
      expect(fake.runInputs[0]?.driver_lock).toBe(fake.handles[0]);
    });

    it("iterate wires the deferred host binding without taking the driver lock", async () => {
      const parent = tempRoot("harness-cli-m4-iterate-");
      const newId = sequentialIds();
      const created = await createNewProject(
        { parentDirectory: parent, name: "m4-iterate", intent: INTENT },
        { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
      );
      if (!created.ok) throw new Error(created.error.message);
      const projectRoot = created.value.projectRoot;
      createRuntimeConfigurationService({
        actor: "human:m4-test",
        clock: () => FIXED_NOW,
      }).persistInitialProfile(projectRoot, "lite");
      const fake = makeFakeSchedulerHost({
        model: (operationId) => fakeSchedulerModel(operationId),
        outcome: COMPLETED_OUTCOME,
      });
      const captured = captureIo();
      const service = createOrchestratedRuntimeService({
        cwd: parent,
        io: captured.io,
        now: () => FIXED_NOW,
        newId,
        execute: createDirectExecutor(),
        capture: captureSeamForTest(projectRoot),
        capabilityPlan: () => undefined,
        schedulerHost: (request) => {
          fake.requests.push(request);
          return fake.host;
        },
      });

      const result = await service.iterate({ projectRoot, text: INTENT });

      // The drive pauses at the capture approval; the parallel binding is
      // inert until the execute node runs, so no lock is taken.
      expect(result.status).toBe("approval_required");
      expect(fake.requests).toEqual([
        { projectRoot, driverKind: "cli", maxConcurrency: 1, live: "write" },
      ]);
      expect(fake.acquired).toEqual([]);
    });
  },
);

describe("status surfaces the scheduler facet", { timeout: 30000 }, () => {
  it("status --json carries the structured scheduler view without acquiring the lock", async () => {
    const harness = await makeParallelHarness("m4-status-json");
    const fake = makeFakeSchedulerHost({
      model: (operationId) =>
        fakeSchedulerModel(operationId, {
          findings: [blockingFinding("finding_gate", "wave_gate_failed")],
        }),
      outcome: COMPLETED_OUTCOME,
    });
    const captured = captureIo();
    const service = serviceFor(harness, fake, captured.io);

    const exitCode = await runCli(["status", "--json"], {
      io: captured.io,
      cwd: harness.projectRoot,
      runtime: service,
    });

    expect(exitCode).toBe(EXIT_CODES.ok);
    const parsed = JSON.parse(captured.stdout()) as {
      data: { scheduler: Record<string, unknown> };
    };
    expect(parsed.data.scheduler).toMatchObject({
      operation_id: harness.workflowOperationId,
      capability_status: "active",
      operation_status: "running",
      live_state: "observed",
      waves: { total: 2, integrated: 1 },
      pending_approvals: [],
      blocking_findings: ["finding_gate"],
      next_action: "scheduler recovery for finding finding_gate: open_gate_evidence_and_replan",
    });
    // Every blocker carries exactly one recovery action; the digest is JSON-only.
    expect(parsed.data.scheduler["blockers"]).toEqual([
      {
        finding_id: "finding_gate",
        rule: "wave_gate_failed",
        recovery_action: "open_gate_evidence_and_replan",
      },
    ]);
    expect(typeof parsed.data.scheduler["digest"]).toBe("string");
    expect(fake.requests).toContainEqual({
      projectRoot: harness.projectRoot,
      driverKind: "cli",
      live: "read",
    });
    expect(fake.acquired).toEqual([]);
  });

  it("status renders the Chinese scheduler copy and per-blocker recovery actions in human mode", async () => {
    const harness = await makeParallelHarness("m4-status-human");
    const model = fakeSchedulerModel(harness.workflowOperationId, {
      findings: [blockingFinding("finding_gate", "wave_gate_failed")],
    });
    const fake = makeFakeSchedulerHost({
      model: () => model,
      outcome: COMPLETED_OUTCOME,
    });
    const captured = captureIo();
    const service = serviceFor(harness, fake, captured.io);

    const exitCode = await runCli(["status"], {
      io: captured.io,
      cwd: harness.projectRoot,
      runtime: service,
    });

    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(captured.stdout()).toMatch(/调度/u);
    expect(captured.stdout()).toContain("波次 1/2");
    expect(captured.stdout()).toContain("恢复动作 open_gate_evidence_and_replan");
    // The model digest never leaks into the human representation.
    expect(captured.stdout()).not.toContain(model.digest);
    expect(fake.acquired).toEqual([]);
  });
});

describe("watch renders the scheduler event vocabulary (M4 design 18)", () => {
  function schedulerEvent(eventType: string, payload: Record<string, unknown>): LifecycleEvent {
    return {
      protocol_version: "1.3.0",
      record_kind: "event",
      event_id: `event_${eventType}`,
      event_type: eventType as LifecycleEvent["event_type"],
      project_id: "project_m4",
      iteration_id: "iteration_m4",
      workflow_operation_id: "workflow_m4",
      ledger_operation_id: "ledger_m4",
      sequence: 1,
      timestamp: FIXED_NOW,
      payload,
    };
  }

  it("renders all eight M4 scheduler event types with their key payload fields", () => {
    const lines = [
      formatEventLine(
        schedulerEvent("TaskLeaseGranted", {
          operation_id: "op",
          task_id: "task_a",
          lease_id: "lease_1",
          slot_id: "slot-1",
          fencing_token: 3,
          plan_digest: "p".repeat(64),
        }),
        { color: false },
      ),
      formatEventLine(
        schedulerEvent("TaskDispatched", {
          operation_id: "op",
          task_id: "task_a",
          run_id: "run_1",
          slot_id: "slot-1",
          attempt_number: 1,
          worktree_locator: "worktree_abc",
        }),
        { color: false },
      ),
      formatEventLine(
        schedulerEvent("TaskIntegrationQueued", {
          operation_id: "op",
          task_id: "task_a",
          run_id: "run_1",
          patch_digest: "b".repeat(64),
        }),
        { color: false },
      ),
      formatEventLine(
        schedulerEvent("TaskCandidateValidated", {
          operation_id: "op",
          task_id: "task_a",
          evidence_digests: ["1".repeat(64), "2".repeat(64)],
        }),
        { color: false },
      ),
      formatEventLine(
        schedulerEvent("TaskRetryScheduled", {
          operation_id: "op",
          task_id: "task_a",
          retry_kind: "executor_retry",
          attempt_number: 2,
          reason: "adapter exited 1",
        }),
        { color: false },
      ),
      formatEventLine(
        schedulerEvent("WaveGateCompleted", {
          operation_id: "op",
          wave_index: 1,
          passed: true,
          evidence_digests: ["3".repeat(64)],
        }),
        { color: false },
      ),
      formatEventLine(
        schedulerEvent("WaveIntegrated", {
          operation_id: "op",
          wave_index: 1,
          task_ids: ["task_a", "task_b"],
          wave_integration_id: "wave_integration_1",
          candidate_commit: "c".repeat(40),
        }),
        { color: false },
      ),
      formatEventLine(
        schedulerEvent("SchedulerRecovered", {
          operation_id: "op",
          recovered_tasks: ["task_a", "task_b"],
          released_leases: ["lease_1"],
        }),
        { color: false },
      ),
    ];

    expect(lines[0]).toContain("TaskLeaseGranted task=task_a slot=slot-1 token=3");
    expect(lines[1]).toContain("TaskDispatched task=task_a run=run_1 slot=slot-1 attempt=1");
    expect(lines[2]).toContain(
      `TaskIntegrationQueued task=task_a run=run_1 patch=${"b".repeat(12)}`,
    );
    expect(lines[3]).toContain("TaskCandidateValidated task=task_a evidence=2");
    expect(lines[4]).toContain(
      "TaskRetryScheduled task=task_a retry=executor_retry attempt=2 reason=adapter exited 1",
    );
    expect(lines[5]).toContain("WaveGateCompleted wave=1 passed=true");
    expect(lines[6]).toContain(`WaveIntegrated wave=1 tasks=2 commit=${"c".repeat(12)}`);
    expect(lines[7]).toContain("SchedulerRecovered recovered=2 released=1");
  });

  it("marks a failed wave gate red like any failed gate", () => {
    const failed = formatEventLine(
      schedulerEvent("WaveGateCompleted", {
        operation_id: "op",
        wave_index: 0,
        passed: false,
        evidence_digests: [],
      }),
      { color: true },
    );
    expect(failed).toContain("wave=0 passed=false");
    expect(failed).toContain("[31m");
  });
});

describe(
  "abort reports a scheduler reconciliation without taking the lock",
  { timeout: 30000 },
  () => {
    it("attaches the post-abort scheduler view and never acquires", async () => {
      const harness = await makeParallelHarness("m4-abort", { approveCapture: false });
      const fake = makeFakeSchedulerHost({
        model: (operationId) => fakeSchedulerModel(operationId),
        outcome: COMPLETED_OUTCOME,
      });
      const captured = captureIo();
      const service = serviceFor(harness, fake, captured.io);

      const result = await service.abort({
        projectRoot: harness.projectRoot,
        workflowOperationId: harness.workflowOperationId,
      });

      expect(result.status).toBe("ok");
      expect(result.data["scheduler"]).toMatchObject({
        operation_id: harness.workflowOperationId,
        capability_status: "active",
        waves: { total: 2, integrated: 1 },
      });
      expect(fake.acquired).toEqual([]);
      expect(fake.modelReads).toEqual([harness.workflowOperationId]);
    });
  },
);

describe("plan presents waves, dependencies, conflicts and budgets", { timeout: 30000 }, () => {
  function handMadeContent(): ExecutionPlanContent {
    const task = (
      id: string,
      objective: string,
      extra: {
        readonly dependencies?: readonly string[];
        readonly write_paths?: readonly string[];
        readonly exclusive_resources?: readonly string[];
      } = {},
    ) => ({
      id,
      objective,
      impact_paths: [[`edge_${id}`]],
      expected_outputs: [`node_${id}`],
      capabilities: ["code-edit"],
      tools: [],
      dependencies: extra.dependencies ?? [],
      risk: "low" as const,
      budget: { steps: 10, tokens: 1000, duration_ms: 60_000 },
      write_paths: extra.write_paths ?? [`src/${id}`],
      exclusive_resources: extra.exclusive_resources ?? [],
      acceptance: [{ description: "works", verification: "unit test" }],
      required_gates: [],
    });
    return {
      content_digest: "c".repeat(64),
      execution_kind: "workflow",
      impact_coverage: {
        execution_kind: "workflow",
        entries: [],
        status: "complete",
        covered_layers: [],
        missing_layers: [],
        forecast_paths: [],
        diagnostics: [],
        risk: "low",
        digest: "d".repeat(64),
      },
      mode: "dag",
      mode_reason: "parallel waves",
      restricted: false,
      impact_set_id: "impact_m4",
      impact_set_digest: "e".repeat(64),
      shared_context: {
        goal: "ship the feature",
        requirement_baseline_digest: "b".repeat(64),
        policy_digest: CAPTURE_POLICY_DIGEST,
        baseline_commit: "0".repeat(40),
        capability_plan_digest: "a".repeat(64),
      },
      tasks: [
        task("task_a", "scaffold"),
        task("task_b", "feature", {
          write_paths: ["src/b"],
          exclusive_resources: ["service-port:8080"],
        }),
        task("task_c", "finish", {
          dependencies: ["task_a"],
          write_paths: ["src/b", "src/c"],
          exclusive_resources: ["service-port:8080"],
        }),
      ],
      iteration_budget: { steps: 60, tokens: 6000, duration_ms: 300_000 },
      parallel_waves: [
        { wave_index: 0, task_ids: ["task_a", "task_b"] },
        { wave_index: 1, task_ids: ["task_c"] },
      ],
    };
  }

  it("renders waves, dependencies, pairwise conflicts and budgets from a 1.3 plan", () => {
    const text = presentExecutionPlan(handMadeContent());
    expect(text).toContain("mode dag");
    expect(text).toContain("3 task(s), 2 wave(s)");
    expect(text).toContain("iteration budget 60 steps / 6000 tokens");
    expect(text).toContain("wave 0: task_a, task_b");
    expect(text).toContain("wave 1: task_c");
    expect(text).toContain('task task_c "finish": deps [task_a]');
    // Pairwise conflict: task_b and task_c overlap on a write path and an
    // exclusive resource claim — the reason they never share a wave.
    expect(text).toContain(
      "conflict: task_b <-> task_c: write_paths [src/b]; exclusive_resources [service-port:8080]",
    );
  });

  it("plan on a driven project keeps the legacy view and adds per-task dependencies and budgets", async () => {
    const harness = await makeParallelHarness("m4-plan-driven");
    const fake = makeFakeSchedulerHost({
      model: (operationId) => fakeSchedulerModel(operationId),
      outcome: COMPLETED_OUTCOME,
    });
    const captured = captureIo();
    const service = serviceFor(harness, fake, captured.io);
    const driven = await service.run({ projectRoot: harness.projectRoot, dryRun: false });
    expect(driven.status).toBe("ok");

    const result = await service.plan({ projectRoot: harness.projectRoot });

    expect(result.status).toBe("ok");
    expect(result.message).toContain("task(s)");
    // The production kernel compiles a legacy sequential plan even on the
    // parallel drive path (the CapabilityPlan DAG, not the plan content, marks
    // execute parallel) — so waves/presentation honestly stay absent here;
    // the pure presentExecutionPlan test above pins the 1.3 rendering.
    expect(result.data["waves"]).toBeUndefined();
    expect(result.data["presentation"]).toBeUndefined();
    const tasks = result.data["tasks"] as readonly {
      id: string;
      dependencies: unknown;
      budget: unknown;
    }[];
    expect(tasks.length).toBeGreaterThan(0);
    expect(
      tasks.every((planned) => Array.isArray(planned.dependencies) && planned.budget !== undefined),
    ).toBe(true);
  });
});

describe("serve resumes workflows under the dashboard driver lock", { timeout: 30000 }, () => {
  const servers: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("stays read-only at startup; the HTTP resume takes and releases the dashboard lock", async () => {
    const harness = await makeParallelHarness("m4-drive-serve");
    const fake = makeFakeSchedulerHost({
      model: (operationId) => fakeSchedulerModel(operationId),
      outcome: (runInput) => ({
        status: "paused",
        operation_id: runInput.operation_id,
        wave_integration_digests: [],
        scheduler_state_digest: "2".repeat(64),
      }),
    });
    const captured = captureIo();
    const service = serviceFor(harness, fake, captured.io, {
      onServerReady: (server) => servers.push(server),
    });

    const started = await service.serve({ projectRoot: harness.projectRoot, port: 0 });
    expect(started.status).toBe("ok");
    // Startup is read-only: no driver lock before any write arrives.
    expect(fake.acquired).toEqual([]);

    const bootstrapUrl = started.data["bootstrap_url"] as string;
    const origin = started.data["origin"] as string;
    const exchange = await fetch(bootstrapUrl, { redirect: "manual" });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    const sessionResponse = await fetch(`${origin}/api/v1/session`, { headers: { cookie } });
    const sessionBody = (await sessionResponse.json()) as { data: { csrf_token: string } };
    const csrf = sessionBody.data.csrf_token;

    const scheduler = await fetch(
      `${origin}/api/v1/scheduler?operation_id=${harness.workflowOperationId}`,
      { headers: { cookie } },
    );
    expect(scheduler.status).toBe(200);
    const schedulerBody = (await scheduler.json()) as {
      data: {
        operation: { operation_id: string };
        tasks: { title: string; authority: string }[];
      };
    };
    expect(schedulerBody.data.operation.operation_id).toBe(harness.workflowOperationId);
    expect(schedulerBody.data.tasks[0]).toMatchObject({
      title: "Task A",
      authority: "authoritative",
    });
    expect(fake.modelReads).toEqual([harness.workflowOperationId]);
    expect(fake.acquired).toEqual([]);

    const current = readCurrentOperation(
      { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
      harness.workflowOperationId,
    );
    const expectedDigest = contentDigest(current);

    const resumed = await fetch(
      `${origin}/api/v1/workflows/${harness.workflowOperationId}/resume`,
      {
        method: "POST",
        headers: {
          cookie,
          origin,
          "content-type": "application/json",
          "x-harness-csrf": csrf,
        },
        body: JSON.stringify({ expected_digest: expectedDigest, actor: "human:web-reviewer" }),
      },
    );

    expect(resumed.status).toBe(200);
    expect(
      fake.requests.some(
        (request) => request.driverKind === "dashboard" && request.live === "write",
      ),
    ).toBe(true);
    expect(fake.acquired).toEqual([harness.workflowOperationId]);
    expect(fake.released).toEqual([harness.workflowOperationId]);
    expect(fake.runInputs).toHaveLength(1);
    expect(fake.runInputs[0]?.driver_lock).toBe(fake.handles[0]);

    const schedulerAfterResume = fakeSchedulerModel(harness.workflowOperationId);

    // The production Policy Proposal path (M4 design 19.4/20): the write
    // persists a durable, digest-bound change_policy ApprovalRequest through
    // the approval machinery and returns its digest; it never mutates an
    // effective limit directly.
    const proposalHeaders = {
      cookie,
      origin,
      "content-type": "application/json",
      "x-harness-csrf": csrf,
    };
    const proposalBody = {
      operation_id: harness.workflowOperationId,
      proposal_kind: "concurrency",
      max_concurrency: 3,
      expected_digest: schedulerAfterResume.digest,
      actor: "human:web-reviewer",
    };
    const proposed = await fetch(`${origin}/api/v1/scheduler/policy-proposals`, {
      method: "POST",
      headers: proposalHeaders,
      body: JSON.stringify(proposalBody),
    });
    expect(proposed.status).toBe(200);
    const proposedBodyJson = (await proposed.json()) as {
      data: {
        status: string;
        proposal_digest: string;
        request_id: string;
        workflow_operation_id: string;
        resume_command: string;
      };
    };
    expect(proposedBodyJson.data.status).toBe("proposed");
    expect(proposedBodyJson.data.proposal_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(proposedBodyJson.data.workflow_operation_id).toBe(harness.workflowOperationId);
    expect(proposedBodyJson.data.resume_command).toBe(
      `harness resume ${harness.workflowOperationId}`,
    );
    const harnessRoot = harnessRootFor(harness.projectRoot);
    const persistedProposal = readApprovalRequests(
      harnessRoot,
      readCommittedOperations(harnessRoot),
      harness.workflowOperationId,
    ).find((request) => request.object_digest === proposedBodyJson.data.proposal_digest);
    expect(persistedProposal).toMatchObject({
      request_id: proposedBodyJson.data.request_id,
      object_type: "change_policy",
      object_id: "scheduler_policy_concurrency",
      risk: "high",
    });

    // A replayed write resolves to the same durable proposal, never a duplicate.
    const replayed = await fetch(`${origin}/api/v1/scheduler/policy-proposals`, {
      method: "POST",
      headers: proposalHeaders,
      body: JSON.stringify(proposalBody),
    });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({
      data: { request_id: proposedBodyJson.data.request_id },
    });
    expect(
      readApprovalRequests(
        harnessRoot,
        readCommittedOperations(harnessRoot),
        harness.workflowOperationId,
      ).filter((request) => request.object_digest === proposedBodyJson.data.proposal_digest),
    ).toHaveLength(1);

    // A stale read branch is a conflict; a structurally invalid ceiling is refused.
    const staleProposal = await fetch(`${origin}/api/v1/scheduler/policy-proposals`, {
      method: "POST",
      headers: proposalHeaders,
      body: JSON.stringify({ ...proposalBody, expected_digest: "0".repeat(64) }),
    });
    expect(staleProposal.status).toBe(409);
    const invalidProposal = await fetch(`${origin}/api/v1/scheduler/policy-proposals`, {
      method: "POST",
      headers: proposalHeaders,
      body: JSON.stringify({
        operation_id: harness.workflowOperationId,
        proposal_kind: "concurrency",
        max_concurrency: 0,
        expected_digest: schedulerAfterResume.digest,
        actor: "human:web-reviewer",
      }),
    });
    expect(invalidProposal.status).toBe(400);

    const afterResume = readCurrentOperation(
      { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
      harness.workflowOperationId,
    );
    const staleCancel = await fetch(
      `${origin}/api/v1/scheduler/operations/${harness.workflowOperationId}/cancel`,
      {
        method: "POST",
        headers: {
          cookie,
          origin,
          "content-type": "application/json",
          "x-harness-csrf": csrf,
        },
        body: JSON.stringify({ expected_digest: "0".repeat(64), actor: "human:web-reviewer" }),
      },
    );
    expect(staleCancel.status).toBe(409);
    expect(
      readCurrentOperation(
        { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
        harness.workflowOperationId,
      )?.state,
    ).toBe(afterResume?.state);

    const cancelled = await fetch(
      `${origin}/api/v1/scheduler/operations/${harness.workflowOperationId}/cancel`,
      {
        method: "POST",
        headers: {
          cookie,
          origin,
          "content-type": "application/json",
          "x-harness-csrf": csrf,
        },
        body: JSON.stringify({
          expected_digest: schedulerAfterResume.digest,
          actor: "human:web-reviewer",
        }),
      },
    );
    expect(cancelled.status).toBe(200);
    expect(fake.cancellations).toEqual([
      {
        operationId: harness.workflowOperationId,
        reason: "dashboard cancellation requested by human:web-reviewer",
      },
    ]);
    expect(
      readCurrentOperation(
        { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
        harness.workflowOperationId,
      )?.state,
    ).toBe("aborted");
  });

  it("keeps the Workflow active when the Scheduler cannot confirm Adapter cancellation", async () => {
    const harness = await makeParallelHarness("m4-cancel-unconfirmed");
    const fake = makeFakeSchedulerHost({
      model: (operationId) => fakeSchedulerModel(operationId),
      outcome: COMPLETED_OUTCOME,
      cancellationStatus: "unconfirmed",
    });
    const service = serviceFor(harness, fake, captureIo().io, {
      onServerReady: (server) => servers.push(server),
    });
    const started = await service.serve({ projectRoot: harness.projectRoot, port: 0 });
    const origin = started.data["origin"] as string;
    const exchange = await fetch(started.data["bootstrap_url"] as string, {
      redirect: "manual",
    });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    const sessionResponse = await fetch(`${origin}/api/v1/session`, { headers: { cookie } });
    const csrf = ((await sessionResponse.json()) as { data: { csrf_token: string } }).data
      .csrf_token;
    const scheduler = await fetch(
      `${origin}/api/v1/scheduler?operation_id=${harness.workflowOperationId}`,
      { headers: { cookie } },
    );
    const schedulerBody = (await scheduler.json()) as {
      data: { control: { expected_digest: string } };
    };
    const before = readCurrentOperation(
      { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
      harness.workflowOperationId,
    );

    const response = await fetch(
      `${origin}/api/v1/scheduler/operations/${harness.workflowOperationId}/cancel`,
      {
        method: "POST",
        headers: {
          cookie,
          origin,
          "content-type": "application/json",
          "x-harness-csrf": csrf,
        },
        body: JSON.stringify({
          expected_digest: schedulerBody.data.control.expected_digest,
          actor: "human:unconfirmed-test",
        }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "write_conflict",
      detail: expect.stringMatching(/could not confirm Agent termination/u),
    });
    expect(
      readCurrentOperation(
        { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
        harness.workflowOperationId,
      ),
    ).toEqual(before);
    expect(fake.cancellations).toHaveLength(1);
  });

  it("returns 409 without aborting the Workflow when cancel meets a real held Driver Lock", async () => {
    const harness = await makeParallelHarness("m4-real-driver-lock");
    const realHost = createProjectSchedulerHost({
      projectRoot: harness.projectRoot,
      readBaseline: () => headOf(harness.projectRoot),
      agentSlotFactory: createProjectAgentSlotFactory({
        projectRoot: harness.projectRoot,
        config: {
          provider: "dsh",
          expected_version: "9.9.9",
          executable: "dsh-not-invoked",
          launcher_args: [],
          env_allowlist: ["PATH"],
          allowed_read_paths: ["."],
          proposed_write_paths: ["."],
        },
      }),
      adapterCapabilities: [],
      projectionStorePath: ":memory:",
      driverKind: "cli",
    });
    const service = createOrchestratedRuntimeService({
      cwd: harness.parent,
      io: captureIo().io,
      now: () => FIXED_NOW,
      newId: harness.newId,
      execute: createDirectExecutor(),
      capture: captureSeamForTest(harness.projectRoot),
      capabilityPlan: () => harness.plan,
      schedulerHost: () => realHost,
      onServerReady: (server) => servers.push(server),
    });
    const lock = await realHost.acquireDriverLock(harness.workflowOperationId);
    try {
      await expect(
        realHost.cancelOperation(harness.workflowOperationId, "held-lock probe"),
      ).rejects.toMatchObject({ name: "DriverLockError", kind: "driver_lock_unavailable" });
      const started = await service.serve({ projectRoot: harness.projectRoot, port: 0 });
      const origin = started.data["origin"] as string;
      const exchange = await fetch(started.data["bootstrap_url"] as string, {
        redirect: "manual",
      });
      const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
      const sessionResponse = await fetch(`${origin}/api/v1/session`, { headers: { cookie } });
      const csrf = ((await sessionResponse.json()) as { data: { csrf_token: string } }).data
        .csrf_token;
      const scheduler = await fetch(
        `${origin}/api/v1/scheduler?operation_id=${harness.workflowOperationId}`,
        { headers: { cookie } },
      );
      const schedulerBody = (await scheduler.json()) as {
        data: { control: { expected_digest: string } };
      };
      const beforeCancel = readCurrentOperation(
        { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
        harness.workflowOperationId,
      );
      const cancel = await fetch(
        `${origin}/api/v1/scheduler/operations/${harness.workflowOperationId}/cancel`,
        {
          method: "POST",
          headers: {
            cookie,
            origin,
            "content-type": "application/json",
            "x-harness-csrf": csrf,
          },
          body: JSON.stringify({
            expected_digest: schedulerBody.data.control.expected_digest,
            actor: "human:real-lock-test",
          }),
        },
      );
      const cancelBody = (await cancel.json()) as unknown;
      expect(cancel.status, JSON.stringify(cancelBody)).toBe(409);
      expect(
        readCurrentOperation(
          { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
          harness.workflowOperationId,
        ),
      ).toEqual(beforeCancel);
      const current = readCurrentOperation(
        { projectRoot: harness.projectRoot, readBaseline: () => headOf(harness.projectRoot) },
        harness.workflowOperationId,
      );
      const response = await fetch(
        `${origin}/api/v1/workflows/${harness.workflowOperationId}/resume`,
        {
          method: "POST",
          headers: {
            cookie,
            origin,
            "content-type": "application/json",
            "x-harness-csrf": csrf,
          },
          body: JSON.stringify({
            expected_digest: contentDigest(current),
            actor: "human:real-lock-test",
          }),
        },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: "write_conflict" });
    } finally {
      await lock.release();
    }
  });
});
