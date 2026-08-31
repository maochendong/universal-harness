import {
  assessUnattendedEligibility,
  type AgentAdapter,
  type AgentProviderManifest,
  type AgentResumeContext,
  type AgentRunMode,
  type AgentRunResult,
  type AgentTaskEnvelope,
} from "@universal-harness-internal/plugin-sdk";

import { redactSchedulerText, redactedWorktreeLocator } from "./events.js";
import type {
  AgentPoolSlot,
  SchedulerLiveSnapshot,
  SchedulerProjectionStore,
  SchedulerTaskLiveObservation,
} from "./ports.js";

/**
 * Fixed-slot isolated Agent pool (M4 design §4.2, plan Task 8 step 2). The
 * pool owns only idle/running slot state and process observation: every run
 * gets its own slot, its own Adapter instance built by the slot factory, its
 * own TaskEnvelope, Run identity, evidence directory and explicit
 * ResumeContext — no Adapter instance, Provider hidden history or mutable
 * Adapter state is ever shared between Tasks.
 *
 * The pool deliberately does NOT read the Plan, judge Policy, issue Leases,
 * accept completions, write the Ledger or integrate Git. Capacity is clamped
 * once by the Scheduler that constructs the pool; the pool never recomputes
 * it. A manual or unattended-ineligible delegated Adapter is forced into
 * supervised single-slot behavior before any process starts: such a run
 * occupies every slot, so nothing else can execute alongside it.
 *
 * Cancellation is cooperative and honest: cancel(runId) aborts that run's
 * AbortController and waits for the Adapter's own result — it never kills by
 * PID outside the supervised child, and a Adapter that ignores the signal
 * simply returns its normal result (termination-unconfirmed); the pool never
 * reports a cancellation the Adapter did not confirm.
 */

export const AGENT_POOL_ERROR_KINDS = [
  "invalid_capacity",
  "pool_exhausted",
  "duplicate_run",
  "unknown_run",
] as const;

export type AgentPoolErrorKind = (typeof AGENT_POOL_ERROR_KINDS)[number];

/** Fail-closed rejection raised by the local agent pool. */
export class AgentPoolError extends Error {
  readonly kind: AgentPoolErrorKind;

  constructor(kind: AgentPoolErrorKind, message: string) {
    super(message);
    this.name = "AgentPoolError";
    this.kind = kind;
  }
}

/** The only per-slot construction seam: one fresh Adapter per run. */
export interface AgentSlotFactory {
  readonly adapter_manifest_digest: string;
  readonly manifest: AgentProviderManifest;
  create(input: {
    readonly slot_id: string;
    readonly worktree_root: string;
    readonly evidence_dir: string;
  }): AgentAdapter;
}

export interface AgentPoolRunInput {
  readonly task_id: string;
  readonly run_id: string;
  readonly workspace_root: string;
  readonly evidence_dir: string;
  readonly envelope: AgentTaskEnvelope;
  readonly mode: AgentRunMode;
  readonly resume?: AgentResumeContext;
}

export interface AgentPoolRunOutcome {
  readonly slot_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly result: AgentRunResult;
}

export interface LocalAgentPool {
  readonly capacity: number;
  run(input: AgentPoolRunInput): Promise<AgentPoolRunOutcome>;
  cancel(runId: string): Promise<void>;
  snapshot(): readonly AgentPoolSlot[];
}

export interface LocalAgentPoolOptions {
  readonly factory: AgentSlotFactory;
  /** Effective concurrency, already clamped by the Scheduler. */
  readonly capacity: number;
  readonly operation_id: string;
  /** Disposable live projection; observation failures never affect runs. */
  readonly projection?: SchedulerProjectionStore;
  /** ISO clock for heartbeats/observed_at; injectable for determinism. */
  readonly now?: () => string;
  /** Millisecond clock for durations; injectable for determinism. */
  readonly now_ms?: () => number;
}

interface MutableSlot {
  slot_id: string;
  state: AgentPoolSlot["state"];
  task_id?: string;
  run_id?: string;
}

interface ActiveRun {
  readonly run_id: string;
  readonly task_id: string;
  readonly slot_ids: readonly string[];
  readonly controller: AbortController;
  readonly started_ms: number;
  /** Settles (never rejects) when the Adapter run promise settles. */
  readonly settled: Promise<void>;
}

type MutableObservation = {
  -readonly [K in keyof SchedulerTaskLiveObservation]: SchedulerTaskLiveObservation[K];
};

export function createLocalAgentPool(options: LocalAgentPoolOptions): LocalAgentPool {
  if (!Number.isInteger(options.capacity) || options.capacity < 1) {
    throw new AgentPoolError(
      "invalid_capacity",
      `pool capacity must be a positive integer, got ${String(options.capacity)}`,
    );
  }
  const now = options.now ?? (() => new Date().toISOString());
  const nowMs = options.now_ms ?? (() => Date.now());
  // Eligibility is a manifest property: compute it once, before any process
  // starts, and force ineligible providers into supervised single-slot runs.
  const eligibility = assessUnattendedEligibility(options.factory.manifest);

  const slots: MutableSlot[] = [];
  for (let index = 1; index <= options.capacity; index += 1) {
    slots.push({ slot_id: `slot_${String(index)}`, state: "idle" });
  }
  const activeRuns = new Map<string, ActiveRun>();
  const knownRunIds = new Set<string>();
  /** Latest live observation per Task; kept after settle until replaced. */
  const observations = new Map<string, MutableObservation>();
  /** Serializes projection writes; observation is disposable, never awaited by callers. */
  let writeChain: Promise<void> = Promise.resolve();

  const persistObservation = (): void => {
    const store = options.projection;
    if (store === undefined) return;
    const snapshot: SchedulerLiveSnapshot = {
      operation_id: options.operation_id,
      observed_at: now(),
      slots: slots.map((slot) => ({ ...slot })),
      tasks: [...observations.values()]
        .map((observation) => ({ ...observation }))
        .sort((left, right) => (left.task_id < right.task_id ? -1 : 1)),
    };
    writeChain = writeChain
      .then(() => store.replace(snapshot))
      .catch(() => {
        // Live observation is explicitly disposable; a projection failure can
        // never fail or alter the governed run.
      });
  };

  const acquireSlots = (run: { task_id: string; run_id: string }): readonly MutableSlot[] => {
    if (!eligibility.eligible) {
      // Supervised single-slot behavior: occupy the whole pool so no other
      // Task can run alongside an adapter that cannot prove unattended control.
      if (slots.some((slot) => slot.state !== "idle")) {
        throw new AgentPoolError(
          "pool_exhausted",
          "an unattended-ineligible adapter requires the whole pool; a run is in flight",
        );
      }
      return slots;
    }
    const idle = slots.find((slot) => slot.state === "idle");
    if (idle === undefined) {
      throw new AgentPoolError(
        "pool_exhausted",
        `no idle slot available for task ${run.task_id} (capacity ${String(options.capacity)})`,
      );
    }
    return [idle];
  };

  const pool: LocalAgentPool = {
    capacity: options.capacity,

    async run(input: AgentPoolRunInput): Promise<AgentPoolRunOutcome> {
      if (knownRunIds.has(input.run_id)) {
        throw new AgentPoolError(
          "duplicate_run",
          `run identity ${input.run_id} was already used; every run mints a fresh identity`,
        );
      }
      const acquired = acquireSlots(input);
      const slotId = acquired[0]!.slot_id;
      knownRunIds.add(input.run_id);
      const controller = new AbortController();
      const startedMs = nowMs();
      for (const slot of acquired) {
        slot.state = "running";
        slot.task_id = input.task_id;
        slot.run_id = input.run_id;
      }
      const observation: MutableObservation = {
        task_id: input.task_id,
        pid: null,
        heartbeat_at: now(),
        output_tail: null,
        steps: null,
        tokens: null,
        duration_ms: 0,
        worktree_id: redactedWorktreeLocator(input.workspace_root),
      };
      observations.set(input.task_id, observation);
      persistObservation();

      // One fresh Adapter instance per run; nothing is reused across Tasks.
      const adapter = options.factory.create({
        slot_id: slotId,
        worktree_root: input.workspace_root,
        evidence_dir: input.evidence_dir,
      });
      const mode: AgentRunMode = eligibility.eligible ? input.mode : "supervised";

      const runPromise = adapter.run(input.envelope, {
        mode,
        ...(input.resume === undefined ? {} : { resume: input.resume }),
        signal: controller.signal,
        on_output: (output) => {
          observation.output_tail = redactSchedulerText(
            (observation.output_tail ?? "") + output.chunk,
          );
          observation.heartbeat_at = now();
          observation.duration_ms = Math.max(0, nowMs() - startedMs);
          persistObservation();
        },
      });
      const active: ActiveRun = {
        run_id: input.run_id,
        task_id: input.task_id,
        slot_ids: acquired.map((slot) => slot.slot_id),
        controller,
        started_ms: startedMs,
        settled: runPromise.then(
          () => undefined,
          () => undefined,
        ),
      };
      activeRuns.set(input.run_id, active);

      try {
        const result = await runPromise;
        return { slot_id: slotId, task_id: input.task_id, run_id: input.run_id, result };
      } finally {
        activeRuns.delete(input.run_id);
        for (const slot of acquired) {
          slot.state = "idle";
          delete slot.task_id;
          delete slot.run_id;
        }
        observation.heartbeat_at = now();
        observation.duration_ms = Math.max(0, nowMs() - startedMs);
        persistObservation();
        // Let the final observation land before the run resolves; the chain
        // already swallows projection failures, so this never fails the run.
        await writeChain;
      }
    },

    async cancel(runId: string): Promise<void> {
      const active = activeRuns.get(runId);
      if (active === undefined) {
        throw new AgentPoolError(
          "unknown_run",
          `no active run ${runId}; only in-flight runs can be cancelled`,
        );
      }
      for (const slot of slots) {
        if (active.slot_ids.includes(slot.slot_id)) slot.state = "cancelling";
      }
      persistObservation();
      // Cooperative abort only: the Adapter's own result is the termination
      // accounting. If the Adapter ignores the signal, its normal result
      // stands and cancellation remains unconfirmed.
      active.controller.abort();
      await active.settled;
    },

    snapshot(): readonly AgentPoolSlot[] {
      return slots.map((slot) => ({ ...slot }));
    },
  };

  return pool;
}
