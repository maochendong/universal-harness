import {
  canonicalizeJson,
  type LifecycleEvent,
  type ObservationEvent,
} from "@universal-harness-internal/core";
import { FileEventStream, type EventStreamItem } from "@universal-harness-internal/runtime";

import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness watch [--lines <n>] [--follow]";

/** Injectable knobs so tests can run follow mode without real timers. */
export interface WatchOptions {
  /** Follow poll interval in milliseconds (default 500). */
  readonly pollIntervalMs?: number;
  /** Hard stop for the follow loop; keeps tests and CI bounded. */
  readonly maxDurationMs?: number;
}

interface ResolvedWatchOptions {
  readonly pollIntervalMs: number;
  readonly maxDurationMs: number | undefined;
}

const DEFAULT_LINES = 20;

const RESET = "\u001b[0m";
const CYAN = "\u001b[36m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const MAGENTA = "\u001b[35m";
const BLUE = "\u001b[34m";
const GRAY = "\u001b[90m";

interface EventStyle {
  readonly icon: string;
  readonly color: string;
}

const EVENT_STYLES: Record<string, EventStyle> = {
  OperationStarted: { icon: "▶", color: CYAN },
  OperationCompleted: { icon: "✔", color: GREEN },
  ApprovalRequired: { icon: "⏸", color: YELLOW },
  CheckpointCommitted: { icon: "◉", color: BLUE },
  PlanAccepted: { icon: "▤", color: CYAN },
  BeforeContextCompile: { icon: "↧", color: BLUE },
  ContextCompiled: { icon: "⇩", color: BLUE },
  BeforeToolCall: { icon: "⚙", color: GRAY },
  AfterToolCall: { icon: "⚙", color: GRAY },
  GateCompleted: { icon: "●", color: GREEN },
  EvaluationCompleted: { icon: "◆", color: GREEN },
  FindingCreated: { icon: "⚠", color: MAGENTA },
  PhaseStarted: { icon: "▶", color: CYAN },
  PhaseCompleted: { icon: "✔", color: GREEN },
  PhasePaused: { icon: "⏸", color: YELLOW },
  GateStarted: { icon: "○", color: CYAN },
  RunStarted: { icon: "▶", color: CYAN },
  RunHeartbeat: { icon: "·", color: GRAY },
  RunOutputSummary: { icon: "…", color: GRAY },
  RunTerminated: { icon: "■", color: GREEN },
  BudgetUpdated: { icon: "◆", color: BLUE },
  // M4 scheduler lifecycle (design §18): timeline facts from the wave driver.
  TaskLeaseGranted: { icon: "⇢", color: BLUE },
  TaskDispatched: { icon: "▶", color: CYAN },
  TaskIntegrationQueued: { icon: "⧉", color: BLUE },
  TaskCandidateValidated: { icon: "✓", color: GREEN },
  TaskRetryScheduled: { icon: "↻", color: YELLOW },
  WaveGateCompleted: { icon: "●", color: GREEN },
  WaveIntegrated: { icon: "◆", color: GREEN },
  SchedulerRecovered: { icon: "♻", color: MAGENTA },
};

type StreamEvent = LifecycleEvent | ObservationEvent;

function describePayload(event: StreamEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const value = payload[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : undefined;
  };
  const first = (...keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const found = text(key);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const count = (key: string): number => {
    const value = payload[key];
    return Array.isArray(value) ? value.length : 0;
  };
  const short = (key: string): string => {
    const value = text(key);
    return value === undefined ? "?" : value.slice(0, 12);
  };
  switch (event.event_type) {
    case "OperationStarted":
      return first("phase") === undefined ? "" : `phase=${first("phase")}`;
    case "OperationCompleted":
      return [
        first("phase") === undefined ? undefined : `phase=${first("phase")}`,
        first("outcome") === undefined ? undefined : `outcome=${first("outcome")}`,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
    case "ApprovalRequired":
      return [
        first("kind") === undefined ? undefined : `kind=${first("kind")}`,
        first("object_type") === undefined ? undefined : `object=${first("object_type")}`,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
    case "PlanAccepted":
      return [
        first("mode") === undefined ? undefined : `mode=${first("mode")}`,
        first("tasks") === undefined ? undefined : `tasks=${first("tasks")}`,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
    case "ContextCompiled":
      return first("included_tokens") === undefined ? "" : `tokens=${first("included_tokens")}`;
    case "GateCompleted":
      return `gate=${first("gate_id") ?? "?"} passed=${first("passed") ?? "?"}`;
    case "EvaluationCompleted":
      return `case=${first("case_id") ?? "?"} passed=${first("passed") ?? "?"}`;
    case "FindingCreated":
      return first("finding_id") === undefined ? "" : `finding=${first("finding_id")}`;
    case "CheckpointCommitted":
      return first("phase") === undefined ? "" : `phase=${first("phase")}`;
    case "TaskLeaseGranted":
      return `task=${first("task_id") ?? "?"} slot=${first("slot_id") ?? "?"} token=${first("fencing_token") ?? "?"}`;
    case "TaskDispatched":
      return `task=${first("task_id") ?? "?"} run=${first("run_id") ?? "?"} slot=${first("slot_id") ?? "?"} attempt=${first("attempt_number") ?? "?"}`;
    case "TaskIntegrationQueued":
      return `task=${first("task_id") ?? "?"} run=${first("run_id") ?? "?"} patch=${short("patch_digest")}`;
    case "TaskCandidateValidated":
      return `task=${first("task_id") ?? "?"} evidence=${String(count("evidence_digests"))}`;
    case "TaskRetryScheduled":
      return `task=${first("task_id") ?? "?"} retry=${first("retry_kind") ?? "?"} attempt=${first("attempt_number") ?? "?"} reason=${first("reason") ?? "?"}`;
    case "WaveGateCompleted":
      return `wave=${first("wave_index") ?? "?"} passed=${first("passed") ?? "?"}`;
    case "WaveIntegrated":
      return `wave=${first("wave_index") ?? "?"} tasks=${String(count("task_ids"))} commit=${short("candidate_commit")}`;
    case "SchedulerRecovered":
      return `recovered=${String(count("recovered_tasks"))} released=${String(count("released_leases"))}`;
    default:
      return first("phase") === undefined ? "" : `phase=${first("phase")}`;
  }
}

function clockOf(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  const seconds = String(parsed.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Render one lifecycle event as a single human-readable line. Pure and
 * side-effect free so tests can pin the exact formatting; `color` toggles the
 * ANSI styling (callers disable it for non-TTY streams and NO_COLOR).
 */
export function formatEventLine(event: StreamEvent, options: { color: boolean }): string {
  const style = EVENT_STYLES[event.event_type];
  const clock = clockOf(event.timestamp);
  const failed =
    (event.event_type === "GateCompleted" ||
      event.event_type === "EvaluationCompleted" ||
      event.event_type === "WaveGateCompleted") &&
    event.payload["passed"] === false;
  const color = failed ? RED : (style?.color ?? GRAY);
  const icon = style?.icon ?? "·";
  const detail = describePayload(event);
  const body = detail === "" ? event.event_type : `${event.event_type} ${detail}`;
  if (!options.color) return `${clock} ${icon} ${body}`;
  return `${GRAY}${clock}${RESET} ${color}${icon} ${body}${RESET}`;
}

function colorEnabled(): boolean {
  return process.env.NO_COLOR === undefined && Boolean(process.stderr.isTTY);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Live view over the project lifecycle event stream (`.harness/events`):
 * renders the newest events as they are committed, so iterations running in
 * other processes (or in the background) stop being a black box. Event lines
 * stream on stderr -- stdout keeps only the final CommandResult, matching the
 * phase-progress convention of the orchestration commands.
 */
export async function runWatchCommand(
  args: readonly string[],
  context: CommandContext,
  watchOptions: WatchOptions = {},
): Promise<CommandResult> {
  const { values } = parseCommandArgs(
    args,
    {
      lines: { type: "string", short: "n" },
      follow: { type: "boolean", short: "f", default: false },
    },
    USAGE,
  );
  const projectRoot = requireProjectRoot(context.cwd);
  const resolved: ResolvedWatchOptions = {
    pollIntervalMs: watchOptions.pollIntervalMs ?? 500,
    maxDurationMs: watchOptions.maxDurationMs,
  };

  const linesRaw = values.lines;
  let limit = DEFAULT_LINES;
  if (linesRaw !== undefined && typeof linesRaw !== "string") {
    throw usageError(`--lines must be a positive integer; usage: ${USAGE}`);
  }
  if (linesRaw !== undefined) {
    const parsed = Number.parseInt(linesRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw usageError(`--lines must be a positive integer; usage: ${USAGE}`);
    }
    limit = parsed;
  }
  const follow = values.follow === true;

  const color = colorEnabled();
  let rendered = 0;
  const emit = (event: StreamEvent): void => {
    rendered += 1;
    if (context.json) {
      context.io.writeStderr(`${canonicalizeJson(event)}\n`);
      return;
    }
    context.io.writeStderr(`${formatEventLine(event, { color })}\n`);
  };

  const stream = new FileEventStream(projectRoot, { pollIntervalMs: resolved.pollIntervalMs });
  const allEvents: EventStreamItem[] = [];
  let cursor: string | undefined;
  let nextCursor: string | undefined;
  do {
    const page = await stream.read({
      limit: 500,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    });
    allEvents.push(...page.items);
    cursor = page.cursor ?? cursor;
    nextCursor = page.nextCursor;
  } while (nextCursor !== undefined);
  const operations = new Set<string>();
  for (const item of allEvents) operations.add(item.event.workflow_operation_id);
  for (const item of allEvents.slice(-limit)) emit(item.event);

  let ticks = 0;
  let stopped = false;
  const onInterrupt = (): void => {
    stopped = true;
  };
  if (follow) {
    process.once("SIGINT", onInterrupt);
    const deadline =
      resolved.maxDurationMs === undefined
        ? Number.POSITIVE_INFINITY
        : Date.now() + resolved.maxDurationMs;
    try {
      while (!stopped && Date.now() < deadline) {
        await sleep(resolved.pollIntervalMs);
        ticks += 1;
        const page = await stream.read({ limit: 500, ...(cursor === undefined ? {} : { cursor }) });
        cursor = page.cursor ?? cursor;
        for (const item of page.items) {
          operations.add(item.event.workflow_operation_id);
          emit(item.event);
        }
      }
    } finally {
      process.removeListener("SIGINT", onInterrupt);
    }
  }

  return {
    command: "watch",
    status: "ok",
    message:
      rendered === 0
        ? "no lifecycle events found"
        : `rendered ${rendered} lifecycle events across ${operations.size} operations`,
    data: {
      events: rendered,
      operations: operations.size,
      lines: limit,
      followed: follow,
      ...(follow ? { ticks } : {}),
    },
  };
}
