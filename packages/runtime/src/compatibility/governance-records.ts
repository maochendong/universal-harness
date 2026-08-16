/**
 * Read-only compatibility projections for pre-hardening governance records.
 * They make historical facts inspectable but deliberately never mint current
 * authority: only the execution preflight may do that from complete bindings.
 */

export interface LegacySnapshotTruthProjection {
  readonly legacy_inferred: true;
  readonly source_commit: string;
  readonly run_outcomes: readonly { readonly id: string; readonly outcome: string }[];
  readonly task_verdicts: readonly {
    readonly task_id: string;
    readonly verdict: "passed" | "failed" | "blocked";
    readonly legacy_inferred: true;
  }[];
  readonly usable_for_execution: false;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function projectLegacySnapshotTruth(snapshot: unknown): LegacySnapshotTruthProjection {
  const record = objectValue(snapshot);
  const sourceCommit = stringValue(record["source_commit"]) ?? stringValue(record["final_commit"]);
  if (sourceCommit === undefined) throw new Error("snapshot carries no source commit");
  const outcomes = Array.isArray(record["run_outcomes"])
    ? record["run_outcomes"].map(objectValue)
    : [];
  const runs = outcomes
    .filter((entry) => stringValue(entry["id"])?.startsWith("run_"))
    .map((entry) => ({
      id: stringValue(entry["id"]) as string,
      outcome: stringValue(entry["outcome"]) ?? "failed",
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const tasks = outcomes
    .filter((entry) => stringValue(entry["id"])?.startsWith("task_"))
    .map((entry) => ({
      task_id: stringValue(entry["id"]) as string,
      verdict: (entry["outcome"] === "success" ? "passed" : "blocked") as "passed" | "blocked",
      legacy_inferred: true as const,
    }))
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
  return {
    legacy_inferred: true,
    source_commit: sourceCommit,
    run_outcomes: runs,
    task_verdicts: tasks,
    usable_for_execution: false,
  };
}

export interface GovernanceMigrationInput {
  readonly plan: unknown;
  readonly contexts: readonly unknown[];
  readonly authorizationRecords: readonly unknown[];
  readonly grantRecords: readonly unknown[];
}

export function governanceMigrationReasons(input: GovernanceMigrationInput): readonly string[] {
  const reasons: string[] = [];
  const plan = objectValue(input.plan);
  if (plan["execution_kind"] !== "workflow" && plan["execution_kind"] !== "agent") {
    reasons.push("execution_kind_missing");
  }
  const tasks = Array.isArray(plan["tasks"]) ? plan["tasks"].map(objectValue) : [];
  const hasAtomicAcceptance =
    tasks.length > 0 &&
    tasks.every((task) => {
      const acceptance = Array.isArray(task["acceptance"])
        ? task["acceptance"].map(objectValue)
        : [];
      return (
        acceptance.length > 0 &&
        acceptance.every((assertion) => stringValue(assertion["assertion_id"]) !== undefined)
      );
    });
  if (!hasAtomicAcceptance) reasons.push("atomic_acceptance_missing");
  for (const context of input.contexts.map(objectValue)) {
    const extensions = objectValue(context["extensions"]);
    if (typeof extensions["harness.context"] !== "object") {
      reasons.push(`task_context_manifest_missing:${stringValue(context["task_id"]) ?? "unknown"}`);
    }
  }
  if (input.authorizationRecords.length === 0) reasons.push("execution_authorization_missing");
  if (input.grantRecords.length === 0) reasons.push("capability_grant_missing");
  return reasons;
}
