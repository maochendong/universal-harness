import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LifecycleEvent } from "@universal-harness-internal/core";

import type { CliIo } from "../src/index.js";
import { formatEventLine, runWatchCommand } from "../src/commands/watch.js";
import type { CommandContext } from "../src/router.js";

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

const createdRoots: string[] = [];

function makeProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-cli-watch-")));
  createdRoots.push(root);
  mkdirSync(join(root, ".harness", "events", "2026-08"), { recursive: true });
  writeFileSync(join(root, ".harness", "manifest.yaml"), "project: demo\n");
  return root;
}

function makeEvent(overrides: Partial<LifecycleEvent>): LifecycleEvent {
  return {
    event_id: "event_01M02WWWWWWWWWWWWWWWWWWWWWWW",
    event_type: "OperationStarted",
    iteration_id: "iteration_01M02WWWWWWWWWWWWWWWWWWWWWW",
    ledger_operation_id: "ledger_01M02WWWWWWWWWWWWWWWWWWWWWW",
    payload: { phase: "capture" },
    project_id: "project_demo",
    protocol_version: "1.0.0",
    record_kind: "event",
    sequence: 1,
    timestamp: "2026-08-15T10:00:00.000Z",
    workflow_operation_id: "workflow_01M02WWWWWWWWWWWWWWWWWWWWW",
    ...overrides,
  } as LifecycleEvent;
}

function writeEvents(projectRoot: string, fileName: string, events: readonly LifecycleEvent[]): void {
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  writeFileSync(join(projectRoot, ".harness", "events", "2026-08", fileName), body);
}

function makeContext(captured: Captured, json: boolean, cwd: string): CommandContext {
  return {
    io: captured.io,
    cwd,
    json,
    // watch never touches the runtime service; the field only satisfies the
    // shared command context shape.
    runtime: undefined as unknown as CommandContext["runtime"],
    gitVersion: () => "git version 2.50.0",
  };
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("formatEventLine", () => {
  it("renders a plain line without ANSI codes", () => {
    const line = formatEventLine(makeEvent({}), { color: false });
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2} ▶ OperationStarted phase=capture$/);
    expect(line).not.toContain("\u001b");
  });

  it("marks failed gates and evaluations distinctly", () => {
    const gate = formatEventLine(
      makeEvent({
        event_type: "GateCompleted",
        payload: { gate_id: "gate.maven", passed: false },
      }),
      { color: false },
    );
    expect(gate).toMatch(/● GateCompleted gate=gate.maven passed=false$/);
    const evaluation = formatEventLine(
      makeEvent({
        event_type: "EvaluationCompleted",
        payload: { case_id: "GC-001", passed: true },
      }),
      { color: false },
    );
    expect(evaluation).toMatch(/◆ EvaluationCompleted case=GC-001 passed=true$/);
  });

  it("colorizes when requested", () => {
    const line = formatEventLine(makeEvent({}), { color: true });
    expect(line).toContain("\u001b[36m");
  });
});

describe("harness watch", () => {
  it("renders the newest snapshot events on stderr and the summary on stdout", async () => {
    const root = makeProject();
    writeEvents(root, "ledger_a.jsonl", [
      makeEvent({ event_id: "event_a1", sequence: 1, timestamp: "2026-08-15T10:00:01.000Z" }),
      makeEvent({
        event_id: "event_a2",
        event_type: "OperationCompleted",
        payload: { phase: "capture", outcome: "baseline_committed" },
        sequence: 2,
        timestamp: "2026-08-15T10:00:02.000Z",
      }),
    ]);
    const captured = captureIo();
    const result = await runWatchCommand([], makeContext(captured, false, root));
    expect(result.status).toBe("ok");
    expect(result.data["events"]).toBe(2);
    expect(result.data["operations"]).toBe(1);
    const lines = captured.stderr().split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("▶ OperationStarted phase=capture");
    expect(lines[1]).toContain("✔ OperationCompleted phase=capture outcome=baseline_committed");
    expect(captured.stdout()).toBe("");
  });

  it("emits canonical NDJSON on stderr in json mode", async () => {
    const root = makeProject();
    writeEvents(root, "ledger_a.jsonl", [
      makeEvent({ event_id: "event_a1", sequence: 1 }),
      makeEvent({
        event_id: "event_a2",
        event_type: "ApprovalRequired",
        payload: { phase: "impact", kind: "approval.objective", object_type: "ImpactSet" },
        sequence: 2,
        timestamp: "2026-08-15T10:00:02.000Z",
      }),
    ]);
    const captured = captureIo();
    const result = await runWatchCommand([], makeContext(captured, true, root));
    expect(result.status).toBe("ok");
    const lines = captured.stderr().split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      expect(event["record_kind"]).toBe("event");
      expect(typeof event["event_id"]).toBe("string");
    }
    const approval = JSON.parse(lines[1] ?? "") as Record<string, unknown>;
    expect(approval["event_type"]).toBe("ApprovalRequired");
    expect(captured.stdout()).toBe("");
  });

  it("honors --lines by rendering only the newest events", async () => {
    const root = makeProject();
    writeEvents(root, "ledger_a.jsonl", [
      makeEvent({ event_id: "event_a1", sequence: 1, timestamp: "2026-08-15T10:00:01.000Z" }),
      makeEvent({ event_id: "event_a2", sequence: 2, timestamp: "2026-08-15T10:00:02.000Z" }),
      makeEvent({ event_id: "event_a3", sequence: 3, timestamp: "2026-08-15T10:00:03.000Z" }),
    ]);
    const captured = captureIo();
    const result = await runWatchCommand(["--lines", "1"], makeContext(captured, false, root));
    expect(result.data["events"]).toBe(1);
    const lines = captured.stderr().split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("OperationStarted");
  });

  it("tails events appended while following", async () => {
    const root = makeProject();
    writeEvents(root, "ledger_a.jsonl", [
      makeEvent({ event_id: "event_a1", sequence: 1, timestamp: "2026-08-15T10:00:01.000Z" }),
    ]);
    const captured = captureIo();
    const appending = setTimeout(() => {
      writeEvents(root, "ledger_b.jsonl", [
        makeEvent({
          event_id: "event_b1",
          event_type: "GateCompleted",
          payload: { gate_id: "gate.maven", passed: true },
          sequence: 1,
          timestamp: "2026-08-15T10:00:09.000Z",
        }),
      ]);
    }, 60);
    try {
      const result = await runWatchCommand(["--follow"], makeContext(captured, false, root), {
        pollIntervalMs: 20,
        maxDurationMs: 240,
      });
      expect(result.data["followed"]).toBe(true);
      expect(result.data["ticks"]).toBeGreaterThan(0);
      const lines = captured.stderr().split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("▶ OperationStarted");
      expect(lines[1]).toContain("● GateCompleted gate=gate.maven passed=true");
    } finally {
      clearTimeout(appending);
    }
  });

  it("rejects invalid --lines values", async () => {
    const root = makeProject();
    const captured = captureIo();
    await expect(
      runWatchCommand(["--lines", "0"], makeContext(captured, false, root)),
    ).rejects.toThrow(/--lines must be a positive integer/);
    expect(root).toBeDefined();
  });
});
