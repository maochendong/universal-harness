import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileEventStream,
  FileLiveSpool,
  readLiveObservations,
} from "../../packages/runtime/src/index.js";

const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "harness-observation-cost-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const input = {
  streamId: "stream_benchmark",
  observationKey: "observation_benchmark",
  eventType: "RunHeartbeat" as const,
  projectId: "project_benchmark",
  iterationId: "iteration_benchmark",
  workflowOperationId: "workflow_benchmark",
  timestamp: "2026-09-08T00:00:00.000Z",
  payload: {},
};
function p95(samples: number[]): number {
  return samples.sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;
}

describe("observation incremental cost", () => {
  it("keeps warm empty polling independent of history size at a fixed file count", async () => {
    const measurements: { events: number; p95_ms: number }[] = [];
    for (const count of [1_000, 100_000]) {
      const projectRoot = root();
      const event = new FileLiveSpool(projectRoot).append(input);
      const path = join(
        projectRoot,
        ".harness/cache/event-stream/stream_benchmark/segment-000001.jsonl",
      );
      const records = Array.from({ length: count }, (_, index) =>
        JSON.stringify({ ...event, sequence: index + 1 }),
      );
      writeFileSync(path, records.join("\n") + "\n");
      const stream = new FileEventStream(projectRoot);
      const view = await stream.refreshView();
      const samples: number[] = [];
      for (let index = 0; index < 220; index += 1) {
        const start = performance.now();
        const page = await stream.read({ cursor: view.headCursor });
        const elapsed = performance.now() - start;
        expect(page.items).toEqual([]);
        if (index >= 20) samples.push(elapsed);
      }
      measurements.push({ events: count, p95_ms: p95(samples) });
    }
    console.info("observation warm polling (fixed F=1):", JSON.stringify(measurements));
    expect(measurements[1]!.p95_ms).toBeLessThanOrEqual(Math.max(25, measurements[0]!.p95_ms * 2));
  }, 30_000);

  it("records live append cost at 1k and 10k without changing the retention contract", () => {
    const measurements: { appends: number; total_ms: number }[] = [];
    for (const count of [1_000, 10_000]) {
      const projectRoot = root();
      mkdirSync(join(projectRoot, ".harness"), { recursive: true });
      const spool = new FileLiveSpool(projectRoot, { maxRecords: count });
      const start = performance.now();
      for (let index = 0; index < count; index += 1) spool.append(input);
      measurements.push({ appends: count, total_ms: performance.now() - start });
      expect(readLiveObservations(projectRoot)).toHaveLength(count);
      expect(spool.append(input).sequence).toBe(count + 1);
      const retained = readLiveObservations(projectRoot);
      expect(retained).toHaveLength(count);
      expect(retained[0]?.sequence).toBe(2);
    }
    console.info(
      "observation append (before steady-state eviction):",
      JSON.stringify(measurements),
    );
  }, 30_000);
});
