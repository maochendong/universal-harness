import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileEventStream, FileLiveSpool } from "../../src/index.js";

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-event-stream-"));
  roots.push(root);
  return root;
}

function writeJsonl(path: string, records: readonly unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FileEventStream", () => {
  it("merges live observations with ledger events and lets authority replace duplicates", async () => {
    const root = projectRoot();
    const observationKey = "gate_gate-01_run-01_completed";
    writeJsonl(join(root, ".harness/cache/event-stream/stream_01/live.jsonl"), [
      {
        stream_version: 1,
        stream_id: "stream_01",
        sequence: 1,
        observation_key: "phase_capture_started",
        event_type: "PhaseStarted",
        project_id: "project_01",
        iteration_id: "iteration_01",
        workflow_operation_id: "workflow_01",
        timestamp: "2026-08-16T00:00:01.000Z",
        payload: { phase: "capture" },
      },
      {
        stream_version: 1,
        stream_id: "stream_01",
        sequence: 2,
        observation_key: observationKey,
        event_type: "GateCompleted",
        project_id: "project_01",
        iteration_id: "iteration_01",
        workflow_operation_id: "workflow_01",
        timestamp: "2026-08-16T00:00:02.000Z",
        payload: { gate_id: "gate_01", passed: true },
      },
    ]);
    writeJsonl(join(root, ".harness/events/2026-08/ledger_01.jsonl"), [
      {
        protocol_version: "1.0.0",
        record_kind: "event",
        event_id: "event_gate-completed_01",
        event_type: "GateCompleted",
        project_id: "project_01",
        iteration_id: "iteration_01",
        workflow_operation_id: "workflow_01",
        ledger_operation_id: "ledger_01",
        sequence: 1,
        timestamp: "2026-08-16T00:00:03.000Z",
        payload: { gate_id: "gate_01", passed: true, observation_key: observationKey },
      },
    ]);

    const page = await new FileEventStream(root).read({ limit: 20 });

    expect(
      page.items.map((item) => ({
        event_type: item.event.event_type,
        source: item.source,
        authoritative: item.authoritative,
      })),
    ).toEqual([
      { event_type: "PhaseStarted", source: "live", authoritative: false },
      { event_type: "GateCompleted", source: "ledger", authoritative: true },
    ]);
  });

  it("pages through a stable opaque cursor without replaying prior events", async () => {
    const root = projectRoot();
    writeJsonl(join(root, ".harness/cache/event-stream/stream_01/live.jsonl"), [
      ...[1, 2, 3].map((sequence) => ({
        stream_version: 1,
        stream_id: "stream_01",
        sequence,
        observation_key: `phase_capture_step-${String(sequence)}`,
        event_type: "PhaseStarted",
        project_id: "project_01",
        iteration_id: "iteration_01",
        workflow_operation_id: "workflow_01",
        timestamp: `2026-08-16T00:00:0${String(sequence)}.000Z`,
        payload: { phase: "capture", step: sequence },
      })),
    ]);
    const stream = new FileEventStream(root);

    const first = await stream.read({ limit: 1 });
    const second = await stream.read({ limit: 1, cursor: first.nextCursor });

    expect(first.nextCursor).toMatch(/^cursor_/u);
    expect(first.items.map((item) => item.id)).toEqual(["live:stream_01:1"]);
    expect(second.items.map((item) => item.id)).toEqual(["live:stream_01:2"]);
  });

  it("filters by iteration, workflow and event type", async () => {
    const root = projectRoot();
    writeJsonl(join(root, ".harness/cache/event-stream/stream_01/live.jsonl"), [
      ...[
        ["iteration_01", "workflow_01", "PhaseStarted"],
        ["iteration_01", "workflow_02", "GateStarted"],
        ["iteration_02", "workflow_01", "GateStarted"],
      ].map(([iterationId, workflowId, eventType], index) => ({
        stream_version: 1,
        stream_id: "stream_01",
        sequence: index + 1,
        observation_key: `observation_${String(index + 1)}`,
        event_type: eventType,
        project_id: "project_01",
        iteration_id: iterationId,
        workflow_operation_id: workflowId,
        timestamp: `2026-08-16T00:00:0${String(index + 1)}.000Z`,
        payload: {},
      })),
    ]);

    const page = await new FileEventStream(root).read({
      iterationId: "iteration_01",
      workflowOperationId: "workflow_02",
      eventTypes: ["GateStarted"],
    });

    expect(page.items.map((item) => item.id)).toEqual(["live:stream_01:2"]);
  });

  it("appends observations with a monotonic sequence that the stream can read", async () => {
    const root = projectRoot();
    const spool = new FileLiveSpool(root);
    const first = spool.append({
      streamId: "stream_01",
      observationKey: "phase_capture_started",
      eventType: "PhaseStarted",
      projectId: "project_01",
      iterationId: "iteration_01",
      workflowOperationId: "workflow_01",
      timestamp: "2026-08-16T00:00:01.000Z",
      payload: { phase: "capture" },
    });
    const second = spool.append({
      streamId: "stream_01",
      observationKey: "phase_capture_completed",
      eventType: "PhaseCompleted",
      projectId: "project_01",
      iterationId: "iteration_01",
      workflowOperationId: "workflow_01",
      timestamp: "2026-08-16T00:00:02.000Z",
      payload: { phase: "capture" },
    });

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect((await new FileEventStream(root).read()).items.map((item) => item.id)).toEqual([
      "live:stream_01:1",
      "live:stream_01:2",
    ]);
  });

  it("preserves numeric stream order when more than nine events share a timestamp", async () => {
    const root = projectRoot();
    const spool = new FileLiveSpool(root);
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      spool.append({
        streamId: "stream_01",
        observationKey: `observation_${String(sequence)}`,
        eventType: "RunHeartbeat",
        projectId: "project_01",
        iterationId: "iteration_01",
        workflowOperationId: "workflow_01",
        timestamp: "2026-08-16T00:00:01.000Z",
        payload: {},
      });
    }

    const page = await new FileEventStream(root).read({ limit: 20 });

    expect(page.items.map((entry) => entry.event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("redacts resolved secret values before an observation reaches disk", async () => {
    const root = projectRoot();
    new FileLiveSpool(root, {
      secrets: new Map([["API_TOKEN", "secret-value-123"]]),
    }).append({
      streamId: "stream_01",
      observationKey: "run_run-01_output",
      eventType: "RunOutputSummary",
      projectId: "project_01",
      iterationId: "iteration_01",
      workflowOperationId: "workflow_01",
      timestamp: "2026-08-16T00:00:01.000Z",
      payload: { summary: "request used secret-value-123" },
    });

    const [item] = (await new FileEventStream(root).read()).items;
    expect(item?.event.payload).toEqual({ summary: "[redacted:secret]" });
    expect(
      readFileSync(
        join(root, ".harness/cache/event-stream/stream_01/segment-000001.jsonl"),
        "utf8",
      ),
    ).not.toContain("secret-value-123");
  });

  it("bounds each live stream to the newest configured record window", async () => {
    const root = projectRoot();
    const spool = new FileLiveSpool(root, { maxRecords: 2 });
    for (const sequence of [1, 2, 3]) {
      spool.append({
        streamId: "stream_01",
        observationKey: `run_run-01_heartbeat-${String(sequence)}`,
        eventType: "RunHeartbeat",
        projectId: "project_01",
        iterationId: "iteration_01",
        workflowOperationId: "workflow_01",
        timestamp: `2026-08-16T00:00:0${String(sequence)}.000Z`,
        payload: { heartbeat: sequence },
      });
    }

    expect((await new FileEventStream(root).read()).items.map((item) => item.id)).toEqual([
      "live:stream_01:2",
      "live:stream_01:3",
    ]);
  });

  it("bounds each live stream by serialized bytes while retaining the newest event", async () => {
    const root = projectRoot();
    const spool = new FileLiveSpool(root, { maxBytes: 700 });
    for (const sequence of [1, 2, 3]) {
      spool.append({
        streamId: "stream_01",
        observationKey: `run_run-01_output-${String(sequence)}`,
        eventType: "RunOutputSummary",
        projectId: "project_01",
        iterationId: "iteration_01",
        workflowOperationId: "workflow_01",
        timestamp: `2026-08-16T00:00:0${String(sequence)}.000Z`,
        payload: { summary: "x".repeat(200) },
      });
    }
    const path = join(root, ".harness/cache/event-stream/stream_01/segment-000001.jsonl");

    expect(statSync(path).size).toBeLessThanOrEqual(700);
    expect((await new FileEventStream(root).read()).items.at(-1)?.id).toBe("live:stream_01:3");
  });

  it("marks a cursor reset when its live observation was evicted", async () => {
    const root = projectRoot();
    const spool = new FileLiveSpool(root, { maxRecords: 2 });
    const append = (sequence: number): void => {
      spool.append({
        streamId: "stream_01",
        observationKey: `run_run-01_heartbeat-${String(sequence)}`,
        eventType: "RunHeartbeat",
        projectId: "project_01",
        iterationId: "iteration_01",
        workflowOperationId: "workflow_01",
        timestamp: `2026-08-16T00:00:0${String(sequence)}.000Z`,
        payload: {},
      });
    };
    append(1);
    append(2);
    const cursor = (await new FileEventStream(root).read({ limit: 1 })).nextCursor;
    append(3);

    const resumed = await new FileEventStream(root).read({ cursor, limit: 10 });

    expect(resumed.reset).toBe(true);
    expect(resumed.items.map((item) => item.id)).toEqual(["live:stream_01:2", "live:stream_01:3"]);
  });

  it("subscribes to observations appended after the initial snapshot", async () => {
    const root = projectRoot();
    const spool = new FileLiveSpool(root);
    const append = (sequence: number): void => {
      spool.append({
        streamId: "stream_01",
        observationKey: `run_run-01_heartbeat-${String(sequence)}`,
        eventType: "RunHeartbeat",
        projectId: "project_01",
        iterationId: "iteration_01",
        workflowOperationId: "workflow_01",
        timestamp: `2026-08-16T00:00:0${String(sequence)}.000Z`,
        payload: {},
      });
    };
    append(1);
    const subscription = new FileEventStream(root, { pollIntervalMs: 1 }).subscribe({ limit: 10 });
    const iterator = subscription[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.id).toBe("live:stream_01:1");
    append(2);
    expect((await iterator.next()).value?.id).toBe("live:stream_01:2");
    await iterator.return?.();
  });

  it("rejects a malformed cursor with a stable error kind", async () => {
    const root = projectRoot();

    await expect(
      new FileEventStream(root).read({ cursor: "cursor_not-base64" }),
    ).rejects.toMatchObject({
      name: "EventStreamError",
      kind: "invalid_cursor",
    });
  });
});
