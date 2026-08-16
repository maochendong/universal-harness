import type { ObservationEvent } from "@universal-harness-internal/core";
import type {
  AgentControlProfile,
  BudgetObservation,
} from "@universal-harness-internal/plugin-sdk";

export interface ActiveRunProjection {
  readonly run_id: string;
  readonly task_id?: string;
  readonly phase?: string;
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly started_at: string;
  readonly elapsed_ms: number;
  readonly last_heartbeat_at: string;
  readonly heartbeat_age_ms: number;
  readonly adapter_control_profile?: AgentControlProfile;
  readonly adapter_profile_digest?: string;
  readonly budget_observations?: readonly BudgetObservation[];
}

function stringValue(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/** Pure lossy projection. It is operational UX only and never completion truth. */
export function projectActiveRun(
  events: readonly ObservationEvent[],
  nowMs: number = Date.now(),
): ActiveRunProjection | undefined {
  let phase: string | undefined;
  let started: ObservationEvent | undefined;
  let heartbeat: ObservationEvent | undefined;
  let budget: ObservationEvent | undefined;
  const terminated = new Set<string>();
  for (const event of [...events].sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? -1 : 1;
    if (left.stream_id === right.stream_id) return left.sequence - right.sequence;
    return left.stream_id < right.stream_id ? -1 : left.stream_id > right.stream_id ? 1 : 0;
  })) {
    if (event.event_type === "PhaseStarted") phase = stringValue(event.payload, "phase") ?? phase;
    if (event.event_type === "RunTerminated") {
      const id = stringValue(event.payload, "run_id");
      if (id !== undefined) terminated.add(id);
      continue;
    }
    if (event.event_type === "RunStarted") {
      const id = stringValue(event.payload, "run_id");
      if (id === undefined) continue;
      started = event;
      heartbeat = event;
      budget = undefined;
      terminated.delete(id);
      continue;
    }
    const activeId = started === undefined ? undefined : stringValue(started.payload, "run_id");
    if (activeId === undefined || stringValue(event.payload, "run_id") !== activeId) continue;
    if (event.event_type === "RunHeartbeat") heartbeat = event;
    if (event.event_type === "BudgetUpdated") budget = event;
  }
  if (started === undefined) return undefined;
  const runId = stringValue(started.payload, "run_id");
  if (runId === undefined || terminated.has(runId)) return undefined;
  const startedMs = Date.parse(started.timestamp);
  const heartbeatAt = heartbeat?.timestamp ?? started.timestamp;
  const heartbeatMs = Date.parse(heartbeatAt);
  const profile = started.payload["adapter_control_profile"];
  const taskId = stringValue(started.payload, "task_id");
  const profileDigest = stringValue(started.payload, "adapter_profile_digest");
  const observations =
    budget?.payload["budget_observations"] ?? started.payload["budget_observations"];
  return {
    run_id: runId,
    ...(taskId === undefined ? {} : { task_id: taskId }),
    ...(phase === undefined ? {} : { phase }),
    workflow_operation_id: started.workflow_operation_id,
    iteration_id: started.iteration_id,
    started_at: started.timestamp,
    elapsed_ms: Math.max(0, nowMs - startedMs),
    last_heartbeat_at: heartbeatAt,
    heartbeat_age_ms: Math.max(0, nowMs - heartbeatMs),
    ...(typeof profile === "object" && profile !== null
      ? { adapter_control_profile: profile as AgentControlProfile }
      : {}),
    ...(profileDigest === undefined ? {} : { adapter_profile_digest: profileDigest }),
    ...(Array.isArray(observations)
      ? { budget_observations: observations as readonly BudgetObservation[] }
      : {}),
  };
}
