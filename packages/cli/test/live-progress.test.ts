import { describe, expect, it } from "vitest";

import type { ObservationEvent } from "@universal-harness-internal/core";

import { LiveProgressReporter } from "../src/live-progress.js";

function event(
  sequence: number,
  eventType: ObservationEvent["event_type"],
  second: number,
  payload: Record<string, unknown>,
): ObservationEvent {
  return {
    stream_version: 1,
    stream_id: "stream_progress_01",
    sequence,
    observation_key: `observation_progress_${String(sequence)}`,
    event_type: eventType,
    project_id: "project_progress_01",
    iteration_id: "iteration_progress_01",
    workflow_operation_id: "workflow_progress_01",
    timestamp: new Date(Date.parse("2026-08-16T00:00:00.000Z") + second * 1000).toISOString(),
    payload,
  };
}

describe("LiveProgressReporter", () => {
  it("aggregates five-second heartbeats to at most one summary per thirty seconds", () => {
    let now = Date.parse("2026-08-16T00:00:00.000Z");
    const reporter = new LiveProgressReporter({ nowMs: () => now });
    const profile = {
      control: "delegated",
      trajectory_visibility: "external-only",
      usage_metering: false,
      side_effect_interception: false,
    };
    expect(
      reporter.observe(
        event(1, "RunStarted", 0, {
          run_id: "run_01",
          task_id: "task_01",
          adapter_control_profile: profile,
          budget_observations: [
            { dimension: "tokens", availability: "unavailable", used: null, limit: 100 },
            { dimension: "steps", availability: "unavailable", used: null, limit: 10 },
          ],
        }),
      ),
    ).toContain("task_01 · delegated/external-only");
    for (let second = 5; second < 30; second += 5) {
      now = Date.parse("2026-08-16T00:00:00.000Z") + second * 1000;
      expect(
        reporter.observe(event(second / 5 + 1, "RunHeartbeat", second, { run_id: "run_01" })),
      ).toBeUndefined();
    }
    now = Date.parse("2026-08-16T00:00:30.000Z");
    const thirty = reporter.observe(event(7, "RunHeartbeat", 30, { run_id: "run_01" }));
    expect(thirty).toContain("elapsed 00:30");
    expect(thirty).toContain("tokens unavailable · steps unavailable");

    now = Date.parse("2026-08-16T00:00:35.000Z");
    expect(reporter.observe(event(8, "RunHeartbeat", 35, { run_id: "run_01" }))).toBeUndefined();
    now = Date.parse("2026-08-16T00:01:00.000Z");
    expect(reporter.observe(event(9, "RunHeartbeat", 60, { run_id: "run_01" }))).toContain(
      "elapsed 01:00",
    );
  });

  it("emits state changes immediately and removes a terminated run", () => {
    let now = Date.parse("2026-08-16T00:00:00.000Z");
    const reporter = new LiveProgressReporter({ nowMs: () => now });
    reporter.observe(event(1, "RunStarted", 0, { run_id: "run_01", task_id: "task_01" }));
    now += 5_000;
    expect(
      reporter.observe(
        event(2, "BudgetUpdated", 5, {
          run_id: "run_01",
          budget_observations: [
            { dimension: "duration_ms", availability: "measured", used: 5000, limit: 60000 },
          ],
        }),
      ),
    ).toContain("duration 5000/60000ms");
    expect(
      reporter.observe(event(3, "RunTerminated", 6, { run_id: "run_01", outcome: "handoff" })),
    ).toContain("handoff");
    expect(reporter.activeRun()).toBeUndefined();
  });
});
