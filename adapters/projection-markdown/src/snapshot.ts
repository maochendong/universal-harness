import { buildProjectionDocument, type ProjectionDocument } from "./index.js";

/**
 * Snapshot projection input (design 10.3). Structurally mirrors the runtime
 * SnapshotRecord; duplicated here because the adapter may not depend on the
 * runtime package. Optional sections render only when present.
 */
export interface SnapshotViewInput {
  readonly snapshot_id: string;
  readonly iteration_id: string;
  readonly status: "completed" | "blocked" | "aborted";
  readonly source_commit?: string;
  readonly final_commit: string;
  readonly workflow_operation_id: string;
  readonly execution_plan_id?: string;
  readonly run_outcomes?: readonly { readonly id: string; readonly outcome: string }[];
  readonly task_verdicts?: readonly {
    readonly verdict_id: string;
    readonly task_id: string;
    readonly verdict: string;
  }[];
  readonly budget?: {
    readonly used_steps: number;
    readonly used_tokens: number;
    readonly ceiling_steps: number;
    readonly ceiling_tokens: number;
  };
  readonly trajectory_summary?: string;
  readonly approvals?: readonly string[];
  readonly evidence?: readonly string[];
  readonly closed_findings?: readonly string[];
  readonly unresolved_items?: readonly string[];
  readonly rejected_hypotheses?: readonly string[];
  readonly improvement_candidates?: readonly { readonly id: string; readonly status: string }[];
  readonly resume_phase?: string;
  readonly blockers?: readonly string[];
  readonly checkpoint_id?: string;
  readonly abort_reason?: string;
}

function listSection(body: string[], title: string, items: readonly string[] | undefined): void {
  if (items === undefined) return;
  body.push(`## ${title}`, "");
  if (items.length === 0) {
    body.push("None.", "");
    return;
  }
  for (const item of items) body.push(`- ${item}`);
  body.push("");
}

/**
 * Render an iteration Snapshot as a human-readable Markdown view. The view is
 * derived from the snapshot record only; the ledger record stays authoritative.
 */
export function renderSnapshotProjection(snapshot: SnapshotViewInput): ProjectionDocument {
  const body: string[] = [
    `# Iteration Snapshot ${snapshot.snapshot_id}`,
    "",
    `- Iteration: ${snapshot.iteration_id}`,
    `- Status: ${snapshot.status}`,
    `- Source commit: ${snapshot.source_commit ?? snapshot.final_commit}`,
    `- Workflow operation: ${snapshot.workflow_operation_id}`,
  ];
  if (snapshot.execution_plan_id !== undefined) {
    body.push(`- Execution plan: ${snapshot.execution_plan_id}`);
  }
  body.push("");

  if (snapshot.run_outcomes !== undefined) {
    body.push("## Run Outcomes", "");
    if (snapshot.run_outcomes.length === 0) body.push("None.", "");
    for (const run of snapshot.run_outcomes) body.push(`- ${run.id}: ${run.outcome}`);
    body.push("");
  }
  if (snapshot.task_verdicts !== undefined) {
    body.push("## Task Verdicts", "");
    if (snapshot.task_verdicts.length === 0) body.push("None.", "");
    for (const verdict of snapshot.task_verdicts) {
      body.push(`- ${verdict.task_id}: ${verdict.verdict} (${verdict.verdict_id})`);
    }
    body.push("");
  }
  if (snapshot.budget !== undefined) {
    body.push(
      "## Budget",
      "",
      `- Steps: ${snapshot.budget.used_steps} of ${snapshot.budget.ceiling_steps}`,
      `- Tokens: ${snapshot.budget.used_tokens} of ${snapshot.budget.ceiling_tokens}`,
      "",
    );
  }
  if (snapshot.trajectory_summary !== undefined) {
    body.push("## Trajectory Summary", "", snapshot.trajectory_summary, "");
  }
  listSection(body, "Approvals", snapshot.approvals);
  listSection(body, "Evidence", snapshot.evidence);
  listSection(body, "Closed Findings", snapshot.closed_findings);
  listSection(body, "Unresolved Items", snapshot.unresolved_items);
  listSection(body, "Rejected Hypotheses", snapshot.rejected_hypotheses);
  if (snapshot.improvement_candidates !== undefined) {
    body.push("## Improvement Candidates", "");
    if (snapshot.improvement_candidates.length === 0) body.push("None.", "");
    for (const candidate of snapshot.improvement_candidates) {
      body.push(`- ${candidate.id}: ${candidate.status}`);
    }
    body.push("");
  }
  if (snapshot.status === "blocked") {
    body.push("## Resume", "");
    if (snapshot.resume_phase !== undefined) body.push(`- Resume phase: ${snapshot.resume_phase}`);
    if (snapshot.checkpoint_id !== undefined) body.push(`- Checkpoint: ${snapshot.checkpoint_id}`);
    for (const blocker of snapshot.blockers ?? []) body.push(`- Blocker: ${blocker}`);
    body.push("");
  }
  if (snapshot.status === "aborted" && snapshot.abort_reason !== undefined) {
    body.push("## Abort", "", `Reason: ${snapshot.abort_reason}`, "");
  }

  return buildProjectionDocument("snapshot", [{ id: snapshot.snapshot_id, revision: 1 }], body);
}
