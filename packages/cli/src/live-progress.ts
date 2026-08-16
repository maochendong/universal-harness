import type { ObservationEvent } from "@universal-harness-internal/core";
import { projectActiveRun, type ActiveRunProjection } from "@universal-harness-internal/runtime";

export interface LiveProgressReporterOptions {
  readonly nowMs?: () => number;
  readonly summaryIntervalMs?: number;
}

function clock(milliseconds: number): string {
  const total = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function budgetText(active: ActiveRunProjection): string | undefined {
  const values = new Map(active.budget_observations?.map((item) => [item.dimension, item]));
  const parts: string[] = [];
  for (const dimension of ["tokens", "steps"] as const) {
    const item = values.get(dimension);
    if (item?.availability === "unavailable") parts.push(`${dimension} unavailable`);
    else if (item !== undefined)
      parts.push(`${dimension} ${String(item.used)}/${String(item.limit)}`);
  }
  const duration = values.get("duration_ms");
  if (duration !== undefined) {
    parts.push(`duration ${String(duration.used)}/${String(duration.limit)}ms`);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

export class LiveProgressReporter {
  private readonly events: ObservationEvent[] = [];
  private readonly nowMs: () => number;
  private readonly summaryIntervalMs: number;
  private lastSummaryAt: number | undefined;

  constructor(options: LiveProgressReporterOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.summaryIntervalMs = options.summaryIntervalMs ?? 30_000;
  }

  activeRun(): ActiveRunProjection | undefined {
    return projectActiveRun(this.events, this.nowMs());
  }

  observe(event: ObservationEvent): string | undefined {
    this.events.push(event);
    const now = this.nowMs();
    const immediate =
      event.event_type === "RunStarted" ||
      event.event_type === "BudgetUpdated" ||
      event.event_type === "RunTerminated";
    if (
      !immediate &&
      (event.event_type !== "RunHeartbeat" ||
        (this.lastSummaryAt !== undefined && now - this.lastSummaryAt < this.summaryIntervalMs))
    ) {
      return undefined;
    }
    if (event.event_type === "RunTerminated") {
      this.lastSummaryAt = now;
      return `${String(event.payload["task_id"] ?? event.payload["run_id"] ?? "run")} · ${String(event.payload["outcome"] ?? "terminated")}`;
    }
    const active = this.activeRun();
    if (active === undefined) return undefined;
    this.lastSummaryAt = now;
    const profile = active.adapter_control_profile;
    const control =
      profile === undefined
        ? "profile unavailable"
        : `${profile.control}/${profile.trajectory_visibility}`;
    const heartbeat = Math.floor(active.heartbeat_age_ms / 1000);
    const first = `${active.task_id ?? active.run_id} · ${control} · elapsed ${clock(active.elapsed_ms)} · heartbeat ${String(heartbeat)}s ago`;
    const budget = budgetText(active);
    return budget === undefined ? first : `${first}\n${budget}`;
  }
}
