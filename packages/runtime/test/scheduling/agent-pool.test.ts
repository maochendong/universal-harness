import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentAdapter,
  AgentProviderManifest,
  AgentRunOptions,
  AgentRunResult,
  AgentTaskEnvelope,
} from "@universal-harness-internal/plugin-sdk";

import {
  AgentPoolError,
  createLocalAgentPool,
  type AgentSlotFactory,
} from "../../src/scheduling/agent-pool.js";
import { createInMemorySchedulerProjectionStore } from "../../src/scheduling/sqlite-projection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function envelope(taskId: string): AgentTaskEnvelope {
  return {
    task_id: taskId,
    plan_id: "plan-1",
    iteration_id: "iteration-1",
    repository_id: "repo-1",
    objective: `Implement ${taskId}`,
    expected_output: "code and tests",
    acceptance_criteria: ["tests pass"],
    required_gate_ids: [],
    allowed_read_paths: ["src"],
    proposed_write_paths: ["src"],
    state_proposal_fields: ["summary"],
    baseline_commit: "0123456789abcdef0123456789abcdef01234567",
    input_digest: "a".repeat(64),
    digest: "b".repeat(64),
    loop_policy: { max_steps: 30, max_tokens: 120000, max_duration_ms: 2700000 },
  };
}

function stubResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: "done",
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      duration_ms: 1,
      metering: "unmetered",
    },
    evidence: [],
    undeclared_writes: [],
    ...overrides,
  };
}

const ELIGIBLE_MANIFEST: AgentProviderManifest = {
  provider: "fixture-managed",
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
  resume_semantics: "explicit",
};

const MANUAL_MANIFEST: AgentProviderManifest = {
  provider: "manual",
  control: "manual",
  trajectory_visibility: "external-only",
  usage_metering: false,
  side_effect_interception: false,
  resume_semantics: "none",
};

/** Barrier that releases every arrived party once `parties` are waiting. */
class RunBarrier {
  currentConcurrent = 0;
  maximumConcurrent = 0;
  private waiting = 0;
  private gate: (() => void) | undefined;

  constructor(private readonly parties: number) {}

  async run<T>(body: () => Promise<T>): Promise<T> {
    this.currentConcurrent += 1;
    this.maximumConcurrent = Math.max(this.maximumConcurrent, this.currentConcurrent);
    this.waiting += 1;
    if (this.waiting === this.parties) this.gate?.();
    await new Promise<void>((resolve) => {
      if (this.waiting >= this.parties) resolve();
      else this.gate = resolve;
    });
    try {
      return await body();
    } finally {
      this.currentConcurrent -= 1;
    }
  }
}

interface RecordedRun {
  readonly adapter: AgentAdapter;
  readonly envelope: AgentTaskEnvelope;
  readonly options: AgentRunOptions;
}

function barrierFactory(
  manifest: AgentProviderManifest,
  barrier: RunBarrier,
  recorded: RecordedRun[],
): AgentSlotFactory {
  return {
    adapter_manifest_digest: "f".repeat(64),
    manifest,
    create: () => {
      const adapter: AgentAdapter = {
        name: `fake-${String(recorded.length)}`,
        manifest,
        run: (runEnvelope, options) =>
          barrier.run(() => {
            recorded.push({ adapter, envelope: runEnvelope, options });
            return Promise.resolve(stubResult());
          }),
      };
      return adapter;
    },
  };
}

function slotInput(taskId: string, runId: string) {
  return {
    task_id: taskId,
    run_id: runId,
    workspace_root: tempDir(`harness-pool-${taskId}-`),
    evidence_dir: tempDir(`harness-pool-evidence-${taskId}-`),
    envelope: envelope(taskId),
    mode: "unattended" as const,
  };
}

describe("local agent pool slot isolation", () => {
  it("runs two tasks concurrently on independent adapter instances", async () => {
    const barrier = new RunBarrier(2);
    const recorded: RecordedRun[] = [];
    const pool = createLocalAgentPool({
      factory: barrierFactory(ELIGIBLE_MANIFEST, barrier, recorded),
      capacity: 2,
      operation_id: "operation_1",
    });

    const runs = await Promise.all([
      pool.run(slotInput("task_a", "run_a")),
      pool.run(slotInput("task_b", "run_b")),
    ]);

    expect(barrier.maximumConcurrent).toBe(2);
    expect(runs.map((run) => run.task_id)).toEqual(["task_a", "task_b"]);
    expect(runs.map((run) => run.run_id)).toEqual(["run_a", "run_b"]);
    expect(runs[0]?.slot_id).not.toBe(runs[1]?.slot_id);
    // No adapter instance or hidden conversation state is ever shared.
    const instances = recorded.map((entry) => entry.adapter);
    expect(new Set(instances).size).toBe(2);
    // Each slot received its own envelope object; nothing is reused.
    expect(recorded[0]?.envelope.task_id).not.toBe(recorded[1]?.envelope.task_id);
    expect(recorded[0]?.envelope).not.toBe(recorded[1]?.envelope);
    // Every slot goes idle again after its run settles.
    expect(pool.snapshot().map((slot) => slot.state)).toEqual(["idle", "idle"]);
  });

  it("hands an explicit per-slot ResumeContext through unchanged", async () => {
    const barrier = new RunBarrier(1);
    const recorded: RecordedRun[] = [];
    const pool = createLocalAgentPool({
      factory: barrierFactory(ELIGIBLE_MANIFEST, barrier, recorded),
      capacity: 1,
      operation_id: "operation_1",
    });
    const resume = {
      note: "continue from the red phase",
      prior_evidence: [{ kind: "transcript", locator: "t.json", digest: "a".repeat(64) }],
    };

    await pool.run({ ...slotInput("task_a", "run_a"), resume });

    expect(recorded[0]?.options.resume).toEqual(resume);
  });

  it("rejects a run when no slot is idle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: AgentSlotFactory = {
      adapter_manifest_digest: "f".repeat(64),
      manifest: ELIGIBLE_MANIFEST,
      create: () => ({
        name: "blocking",
        manifest: ELIGIBLE_MANIFEST,
        run: async () => {
          await gate;
          return stubResult();
        },
      }),
    };
    const pool = createLocalAgentPool({ factory, capacity: 1, operation_id: "operation_1" });
    const first = pool.run(slotInput("task_a", "run_a"));

    await expect(pool.run(slotInput("task_b", "run_b"))).rejects.toMatchObject({
      name: "AgentPoolError",
      kind: "pool_exhausted",
    });

    release();
    await first;
  });

  it("rejects a reused run identity", async () => {
    const recorded: RecordedRun[] = [];
    const pool = createLocalAgentPool({
      factory: barrierFactory(ELIGIBLE_MANIFEST, new RunBarrier(1), recorded),
      capacity: 1,
      operation_id: "operation_1",
    });
    await pool.run(slotInput("task_a", "run_a"));

    await expect(pool.run(slotInput("task_b", "run_a"))).rejects.toMatchObject({
      kind: "duplicate_run",
    });
  });

  it("refuses a non-positive capacity at construction", () => {
    expect(() =>
      createLocalAgentPool({
        factory: barrierFactory(ELIGIBLE_MANIFEST, new RunBarrier(1), []),
        capacity: 0,
        operation_id: "operation_1",
      }),
    ).toThrowError(AgentPoolError);
  });
});

describe("local agent pool unattended gating", () => {
  it("forces a manual adapter into supervised single-slot behavior before any process starts", async () => {
    const recorded: RecordedRun[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: AgentSlotFactory = {
      adapter_manifest_digest: "f".repeat(64),
      manifest: MANUAL_MANIFEST,
      create: () => {
        const adapter: AgentAdapter = {
          name: "manual-fake",
          manifest: MANUAL_MANIFEST,
          run: async (runEnvelope, options) => {
            recorded.push({ adapter, envelope: runEnvelope, options });
            await gate;
            return stubResult();
          },
        };
        return adapter;
      },
    };
    const pool = createLocalAgentPool({ factory, capacity: 2, operation_id: "operation_1" });

    const first = pool.run(slotInput("task_a", "run_a"));
    // The exclusive supervised slot occupies the whole pool before any
    // process starts: a second run is refused instead of running in parallel.
    await expect(pool.run(slotInput("task_b", "run_b"))).rejects.toMatchObject({
      kind: "pool_exhausted",
    });
    expect(pool.snapshot().every((slot) => slot.state === "running")).toBe(true);

    release();
    const outcome = await first;
    // The requested unattended mode was forced to supervised.
    expect(recorded[0]?.options.mode).toBe("supervised");
    expect(outcome.result.termination_reason).toBe("completion");
  });
});

describe("local agent pool cancellation", () => {
  it("aborts the run controller and waits for the adapter termination accounting", async () => {
    const recorded: RecordedRun[] = [];
    const factory: AgentSlotFactory = {
      adapter_manifest_digest: "f".repeat(64),
      manifest: ELIGIBLE_MANIFEST,
      create: () => {
        const adapter: AgentAdapter = {
          name: "cancellable",
          manifest: ELIGIBLE_MANIFEST,
          run: (runEnvelope, options) =>
            new Promise<AgentRunResult>((resolve) => {
              recorded.push({ adapter, envelope: runEnvelope, options });
              options.signal?.addEventListener(
                "abort",
                () => {
                  resolve(
                    stubResult({
                      outcome: "partial",
                      termination_reason: "user_cancellation",
                      completion_claimed: false,
                      summary: "aborted",
                    }),
                  );
                },
                { once: true },
              );
            }),
        };
        return adapter;
      },
    };
    const pool = createLocalAgentPool({ factory, capacity: 2, operation_id: "operation_1" });
    const running = pool.run(slotInput("task_a", "run_a"));
    // Wait until the adapter observed the run before cancelling.
    await vi.waitFor(() => {
      expect(recorded).toHaveLength(1);
    });

    expect(pool.snapshot().find((slot) => slot.run_id === "run_a")?.state).toBe("running");
    await pool.cancel("run_a");
    const outcome = await running;

    expect(outcome.result.termination_reason).toBe("user_cancellation");
    expect(recorded[0]?.options.signal?.aborted).toBe(true);
    expect(pool.snapshot().every((slot) => slot.state === "idle")).toBe(true);
  });

  it("never claims cancellation for an adapter that ignores the signal", async () => {
    const factory: AgentSlotFactory = {
      adapter_manifest_digest: "f".repeat(64),
      manifest: ELIGIBLE_MANIFEST,
      create: () => ({
        name: "oblivious",
        manifest: ELIGIBLE_MANIFEST,
        run: () =>
          new Promise<AgentRunResult>((resolve) => {
            setTimeout(() => {
              resolve(stubResult());
            }, 50);
          }),
      }),
    };
    const pool = createLocalAgentPool({ factory, capacity: 1, operation_id: "operation_1" });
    const running = pool.run(slotInput("task_a", "run_a"));

    await pool.cancel("run_a");
    const outcome = await running;

    // Termination-unconfirmed: the adapter completed normally, so the pool
    // reports the adapter's own result -- never an invented cancellation.
    expect(outcome.result.termination_reason).toBe("completion");
  });

  it("rejects cancelling an unknown run", async () => {
    const pool = createLocalAgentPool({
      factory: barrierFactory(ELIGIBLE_MANIFEST, new RunBarrier(1), []),
      capacity: 1,
      operation_id: "operation_1",
    });

    await expect(pool.cancel("run_missing")).rejects.toMatchObject({ kind: "unknown_run" });
  });
});

describe("local agent pool live observation", () => {
  it("writes redacted output tails through the projection store with unmetered fields null", async () => {
    const store = createInMemorySchedulerProjectionStore();
    const home = tempDir("harness-pool-home-");
    const factory: AgentSlotFactory = {
      adapter_manifest_digest: "f".repeat(64),
      manifest: ELIGIBLE_MANIFEST,
      create: () => ({
        name: "chatty",
        manifest: ELIGIBLE_MANIFEST,
        run: (_runEnvelope, options) => {
          options.on_output?.({ stream: "stdout", chunk: `wrote ${home}/src/a.ts\n` });
          options.on_output?.({ stream: "stderr", chunk: "tests green\n" });
          return Promise.resolve(stubResult());
        },
      }),
    };
    const pool = createLocalAgentPool({
      factory,
      capacity: 1,
      operation_id: "operation_1",
      projection: store,
      now: () => "2026-08-31T00:00:00.000Z",
      now_ms: () => 42,
    });

    await pool.run(slotInput("task_a", "run_a"));

    const snapshot = await store.read("operation_1");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.observed_at).toBe("2026-08-31T00:00:00.000Z");
    const task = snapshot?.tasks.find((entry) => entry.task_id === "task_a");
    // Unmeterable tokens/steps stay null -- never displayed as zero.
    expect(task?.steps).toBeNull();
    expect(task?.tokens).toBeNull();
    expect(task?.pid).toBeNull();
    // The tail is redacted: no absolute user path survives into live state.
    expect(task?.output_tail).toContain("tests green");
    expect(task?.output_tail).not.toContain(home);
    // The worktree locator is a digest, never the absolute path.
    expect(task?.worktree_id).toMatch(/^worktree_[a-f0-9]{12}$/u);
    expect(snapshot?.slots.map((slot) => slot.state)).toEqual(["idle"]);
  });
});
