import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { LifecycleEvent } from "@universal-harness-internal/core";
import { canonicalizeJson } from "@universal-harness-internal/core";

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
};

function describePayload(event: LifecycleEvent): string {
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
  switch (event.event_type) {
    case "OperationStarted":
      return first("phase") === undefined ? "" : `phase=${first("phase")}`;
    case "OperationCompleted":
      return [first("phase") === undefined ? undefined : `phase=${first("phase")}`,
        first("outcome") === undefined ? undefined : `outcome=${first("outcome")}`]
        .filter((part) => part !== undefined)
        .join(" ");
    case "ApprovalRequired":
      return [first("kind") === undefined ? undefined : `kind=${first("kind")}`,
        first("object_type") === undefined ? undefined : `object=${first("object_type")}`]
        .filter((part) => part !== undefined)
        .join(" ");
    case "PlanAccepted":
      return [first("mode") === undefined ? undefined : `mode=${first("mode")}`,
        first("tasks") === undefined ? undefined : `tasks=${first("tasks")}`]
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
export function formatEventLine(event: LifecycleEvent, options: { color: boolean }): string {
  const style = EVENT_STYLES[event.event_type];
  const clock = clockOf(event.timestamp);
  const failed =
    (event.event_type === "GateCompleted" || event.event_type === "EvaluationCompleted") &&
    event.payload["passed"] === false;
  const color = failed ? RED : style?.color ?? GRAY;
  const icon = style?.icon ?? "·";
  const detail = describePayload(event);
  const body = detail === "" ? event.event_type : `${event.event_type} ${detail}`;
  if (!options.color) return `${clock} ${icon} ${body}`;
  return `${GRAY}${clock}${RESET} ${color}${icon} ${body}${RESET}`;
}

function colorEnabled(): boolean {
  return process.env.NO_COLOR === undefined && Boolean(process.stderr.isTTY);
}

function listEventFiles(projectRoot: string): string[] {
  const eventsRoot = join(projectRoot, ".harness", "events");
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  };
  walk(eventsRoot);
  return files.sort();
}

function parseEventLines(path: string, start: number, end: number): LifecycleEvent[] {
  if (end <= start) return [];
  const buffer = readFileSync(path);
  const slice = buffer.subarray(start, end).toString("utf8");
  const events: LifecycleEvent[] = [];
  for (const line of slice.split("\n")) {
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["record_kind"] === "event" && typeof parsed["event_id"] === "string") {
        events.push(parsed as unknown as LifecycleEvent);
      }
    } catch {
      // Partially written tail lines are skipped; the next tick re-reads them.
    }
  }
  return events;
}

function sortEvents(events: readonly LifecycleEvent[]): LifecycleEvent[] {
  return [...events].sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? -1 : 1;
    return left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0;
  });
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

  const offsets = new Map<string, number>();
  const drainNewEvents = (): LifecycleEvent[] => {
    const collected: LifecycleEvent[] = [];
    for (const path of listEventFiles(projectRoot)) {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      const previous = offsets.get(path) ?? 0;
      if (size > previous) collected.push(...parseEventLines(path, previous, size));
      offsets.set(path, size);
    }
    return sortEvents(collected);
  };

  const color = colorEnabled();
  let rendered = 0;
  const emit = (event: LifecycleEvent): void => {
    rendered += 1;
    if (context.json) {
      context.io.writeStderr(`${canonicalizeJson(event)}\n`);
      return;
    }
    context.io.writeStderr(`${formatEventLine(event, { color })}\n`);
  };

  const allEvents = drainNewEvents();
  const operations = new Set<string>();
  for (const event of allEvents) operations.add(event.workflow_operation_id);
  for (const event of allEvents.slice(-limit)) emit(event);

  let ticks = 0;
  let stopped = false;
  const onInterrupt = (): void => {
    stopped = true;
  };
  if (follow) {
    process.once("SIGINT", onInterrupt);
    const deadline = resolved.maxDurationMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + resolved.maxDurationMs;
    try {
      while (!stopped && Date.now() < deadline) {
        await sleep(resolved.pollIntervalMs);
        ticks += 1;
        for (const event of drainNewEvents()) {
          operations.add(event.workflow_operation_id);
          emit(event);
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
