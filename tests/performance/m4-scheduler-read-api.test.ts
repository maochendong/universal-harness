import { describe, expect, it } from "vitest";

import {
  buildSchedulerReadModelBenchmarkFixture,
  readSchedulerModel,
} from "../../packages/runtime/src/scheduling/read-model.js";
import type { SchedulerAuthority } from "../../packages/runtime/src/scheduling/scheduler.js";

import { measure, recordBaseline, summarizeSamples } from "./helpers.js";

const TASK_COUNT = 1_000;
const WARM_READS = 5;
const MEASURED_READS = 50;
const READ_P95_THRESHOLD_MS = 250;

describe("m4 scheduler Read API performance gate", () => {
  it("projects 1,000 tasks with p95 below 250ms", async () => {
    const fixture = buildSchedulerReadModelBenchmarkFixture({
      task_count: TASK_COUNT,
      wave_size: 8,
      integrated_waves: 20,
    });
    const authority: SchedulerAuthority = {
      readFacts: () => Promise.resolve(fixture.facts),
      commit: () => Promise.reject(new Error("read benchmark never commits")),
    };
    const read = () =>
      readSchedulerModel({
        capability: "active",
        operation_id: fixture.dag.operation_id,
        dag_port: {
          name: "m4-read-benchmark",
          readApproved: () => Promise.resolve(fixture.dag),
        },
        authority,
        now: () => "2026-08-31T00:10:00.000Z",
      });

    for (let index = 0; index < WARM_READS; index += 1) await read();
    const samples: number[] = [];
    let lastTaskCount = 0;
    for (let index = 0; index < MEASURED_READS; index += 1) {
      const started = measure(() => performance.now());
      const model = await read();
      samples.push(performance.now() - started.result);
      lastTaskCount = model.tasks.length;
    }
    const summary = summarizeSamples(samples);
    recordBaseline("m4-scheduler-read-api", {
      metric: "scheduler_read_api",
      operation_scale: { tasks: TASK_COUNT, samples: MEASURED_READS },
      threshold_ms: READ_P95_THRESHOLD_MS,
      timing: summary,
    });

    expect(lastTaskCount).toBe(TASK_COUNT);
    expect(
      summary.p95_ms,
      `Scheduler Read API p95 ${String(summary.p95_ms)}ms exceeds ${String(
        READ_P95_THRESHOLD_MS,
      )}ms`,
    ).toBeLessThan(READ_P95_THRESHOLD_MS);
  });
});
