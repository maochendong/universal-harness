import { describe, expect, it } from "vitest";

import type { ObservationEvent } from "@universal-harness-internal/core";

import { projectActiveRun } from "../../src/index.js";

function event(
  sequence: number,
  eventType: ObservationEvent["event_type"],
  timestamp: string,
  payload: Record<string, unknown>,
): ObservationEvent {
  return {
    stream_version: 1,
    stream_id: "stream_active_01",
    sequence,
    observation_key: `observation_active_${String(sequence)}`,
    event_type: eventType,
    project_id: "project_active_01",
    iteration_id: "iteration_active_01",
    workflow_operation_id: "workflow_active_01",
    timestamp,
    payload,
  };
}

describe("active run projection", () => {
  it("projects elapsed time, heartbeat age, profile and budget availability", () => {
    const active = projectActiveRun(
      [
        event(1, "PhaseStarted", "2026-08-16T00:00:00.000Z", { phase: "execute" }),
        event(2, "RunStarted", "2026-08-16T00:00:01.000Z", {
          run_id: "run_01",
          task_id: "task_01",
          adapter_control_profile: {
            control: "delegated",
            trajectory_visibility: "external-only",
            usage_metering: false,
            side_effect_interception: false,
          },
        }),
        event(3, "RunHeartbeat", "2026-08-16T00:01:00.000Z", {
          run_id: "run_01",
          task_id: "task_01",
        }),
        event(4, "BudgetUpdated", "2026-08-16T00:01:02.000Z", {
          run_id: "run_01",
          budget_observations: [
            { dimension: "tokens", availability: "unavailable", used: null, limit: 1 },
          ],
        }),
      ],
      Date.parse("2026-08-16T00:01:06.000Z"),
    );

    expect(active).toMatchObject({
      run_id: "run_01",
      task_id: "task_01",
      phase: "execute",
      elapsed_ms: 65_000,
      heartbeat_age_ms: 6_000,
      adapter_control_profile: { control: "delegated" },
      budget_observations: [{ dimension: "tokens", availability: "unavailable" }],
    });
  });

  it("removes the active projection after RunTerminated", () => {
    expect(
      projectActiveRun(
        [
          event(1, "RunStarted", "2026-08-16T00:00:00.000Z", { run_id: "run_01" }),
          event(2, "RunTerminated", "2026-08-16T00:00:10.000Z", {
            run_id: "run_01",
            outcome: "handoff",
          }),
        ],
        Date.parse("2026-08-16T00:00:11.000Z"),
      ),
    ).toBeUndefined();
  });
});
