import { contentDigest } from "@universal-harness-internal/core";

import { governanceMigrationReasons } from "./governance-records.js";

export interface OpenIterationMigrationInput {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly plan: unknown;
  readonly contexts: readonly unknown[];
  readonly authorization_records: readonly unknown[];
  readonly grant_records: readonly unknown[];
  /** Legacy checkpoints stored bare grant digests without complete records. */
  readonly relied_grant_digests: readonly string[];
}

export interface OpenIterationMigrationAssessment {
  readonly required: boolean;
  readonly reasons: readonly string[];
  readonly resume_phase: "impact" | "plan";
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function assessOpenIterationMigration(
  input: OpenIterationMigrationInput,
): OpenIterationMigrationAssessment {
  const authorityWasReliedOn = input.relied_grant_digests.length > 0;
  const reasons = governanceMigrationReasons({
    plan: input.plan,
    contexts: input.contexts,
    authorizationRecords: authorityWasReliedOn ? input.authorization_records : [{}],
    grantRecords: authorityWasReliedOn ? input.grant_records : [{}],
  });
  const plan = objectValue(input.plan);
  const coverage = objectValue(plan["impact_coverage"]);
  const all = [
    ...reasons,
    ...(coverage["status"] === "incomplete" ? ["impact_coverage_incomplete"] : []),
  ];
  return {
    required: all.length > 0,
    reasons: [...new Set(all)],
    resume_phase: all.includes("impact_coverage_incomplete") ? "impact" : "plan",
  };
}

export interface OpenIterationMigrationRecord {
  readonly record_kind: "open_iteration_migration";
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly status: "required";
  readonly reasons: readonly string[];
  readonly resume_phase: "impact" | "plan";
  readonly invalidated: {
    readonly plan_digest?: string;
    readonly context_digests: readonly string[];
    readonly grant_digests: readonly string[];
  };
  readonly created_at: string;
  readonly digest: string;
}

export function buildOpenIterationMigrationRecord(
  input: OpenIterationMigrationInput,
  assessment: OpenIterationMigrationAssessment,
  createdAt: string,
): OpenIterationMigrationRecord {
  if (!assessment.required) throw new Error("migration record requires at least one reason");
  const plan = objectValue(input.plan);
  const invalidatesPlan = assessment.reasons.some(
    (reason) =>
      reason === "execution_kind_missing" ||
      reason === "atomic_acceptance_missing" ||
      reason === "impact_coverage_incomplete",
  );
  const planDigest = invalidatesPlan ? stringValue(plan["content_digest"]) : undefined;
  const contextDigests = input.contexts
    .map((context) => stringValue(objectValue(context)["digest"]))
    .filter((digest): digest is string => digest !== undefined)
    .sort();
  const content = {
    record_kind: "open_iteration_migration" as const,
    workflow_operation_id: input.workflow_operation_id,
    iteration_id: input.iteration_id,
    status: "required" as const,
    reasons: [...assessment.reasons],
    resume_phase: assessment.resume_phase,
    invalidated: {
      ...(planDigest === undefined ? {} : { plan_digest: planDigest }),
      context_digests: contextDigests,
      grant_digests: [...new Set(input.relied_grant_digests)].sort(),
    },
    created_at: createdAt,
  };
  return { ...content, digest: contentDigest(content) };
}
