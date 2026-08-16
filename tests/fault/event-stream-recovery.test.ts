import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileEventStream,
  FileLiveSpool,
  type EventStreamItem,
} from "../../packages/runtime/src/index.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harness-event-recovery-"));
  roots.push(value);
  return value;
}

function ledgerEvent(observationKey: string): Record<string, unknown> {
  return {
    protocol_version: "1.0.0",
    record_kind: "event",
    event_id: "event_recovered-01",
    event_type: "GateCompleted",
    project_id: "project_recovery",
    iteration_id: "iteration_recovery",
    workflow_operation_id: "workflow_recovery",
    ledger_operation_id: "ledger_recovery",
    sequence: 1,
    timestamp: "2026-08-16T00:00:02.000Z",
    payload: { observation_key: observationKey, gate_id: "gate_recovery", passed: true },
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Event stream fault recovery", () => {
  it("signals reset when a retained live cursor disappears with the spool", async () => {
    const projectRoot = root();
    const spool = new FileLiveSpool(projectRoot);
    for (let index = 1; index <= 3; index += 1) {
      spool.append({
        streamId: "stream_recovery",
        observationKey: `observation_recovery-${String(index)}`,
        eventType: "RunHeartbeat",
        projectId: "project_recovery",
        iterationId: "iteration_recovery",
        workflowOperationId: "workflow_recovery",
        timestamp: `2026-08-16T00:00:0${String(index)}.000Z`,
        payload: { run_id: "run_recovery" },
      });
    }
    const first = await new FileEventStream(projectRoot).read({ limit: 1 });
    expect(first.nextCursor).toMatch(/^cursor_/u);

    rmSync(join(projectRoot, ".harness", "cache", "event-stream"), {
      recursive: true,
      force: true,
    });
    const restarted = await new FileEventStream(projectRoot).read({
      cursor: first.nextCursor,
      limit: 10,
    });
    expect(restarted).toMatchObject({ items: [], reset: true });
  });

  it("recovers authoritative history after restart even when live state is deleted", async () => {
    const projectRoot = root();
    const observationKey = "observation_gate-recovery";
    new FileLiveSpool(projectRoot).append({
      streamId: "stream_recovery",
      observationKey,
      eventType: "GateCompleted",
      projectId: "project_recovery",
      iterationId: "iteration_recovery",
      workflowOperationId: "workflow_recovery",
      timestamp: "2026-08-16T00:00:01.000Z",
      payload: { gate_id: "gate_recovery", passed: true },
    });
    const eventPath = join(projectRoot, ".harness", "events", "2026-08", "ledger.jsonl");
    mkdirSync(join(eventPath, ".."), { recursive: true });
    writeFileSync(eventPath, `${JSON.stringify(ledgerEvent(observationKey))}\n`, "utf8");

    const before = await new FileEventStream(projectRoot).read({ limit: 10 });
    expect(before.items).toEqual([
      expect.objectContaining({ source: "ledger", authoritative: true }),
    ]);
    rmSync(join(projectRoot, ".harness", "cache", "event-stream"), {
      recursive: true,
      force: true,
    });

    const afterRestart = await new FileEventStream(projectRoot).read({ limit: 10 });
    expect(afterRestart.items.map((item: EventStreamItem) => item.id)).toEqual([
      "ledger:event_recovered-01",
    ]);
    expect(afterRestart.items[0]).toMatchObject({ source: "ledger", authoritative: true });
  });

  it("ignores an incomplete live tail instead of inventing a terminal event", async () => {
    const projectRoot = root();
    const path = join(
      projectRoot,
      ".harness",
      "cache",
      "event-stream",
      "stream_recovery",
      "segment-000001.jsonl",
    );
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"stream_version":1,"event_type":"OperationCompleted"', "utf8");

    await expect(new FileEventStream(projectRoot).read()).resolves.toEqual({ items: [] });
  });
});
