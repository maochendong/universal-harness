import type { AgentRunResult } from "@universal-harness-internal/plugin-sdk";

import type { TaskVerdictRecord } from "./task-verdict.js";

/** Provider/Harness run facts are immutable and never promoted to synthetic success. */
export function projectRunFact(
  runId: string,
  result: AgentRunResult,
): {
  readonly id: string;
  readonly outcome: AgentRunResult["outcome"];
} {
  return { id: runId, outcome: result.outcome };
}

/** Task completion is a verdict over proof, not a rewrite of its Run outcome. */
export function projectTaskVerdict(verdict: TaskVerdictRecord): {
  readonly verdict_id: string;
  readonly task_id: string;
  readonly verdict: TaskVerdictRecord["verdict"];
} {
  return {
    verdict_id: verdict.verdict_id,
    task_id: verdict.task_id,
    verdict: verdict.verdict,
  };
}
