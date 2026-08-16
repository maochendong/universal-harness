import { describe, expect, it } from "vitest";

import {
  assessOpenIterationMigration,
  buildOpenIterationMigrationRecord,
} from "../../src/index.js";

describe("open legacy iteration migration", () => {
  it("requires plan migration for direct Agent plans, shared contexts and bare grants", () => {
    const assessment = assessOpenIterationMigration({
      workflow_operation_id: "workflow_legacy",
      iteration_id: "iteration_legacy",
      plan: {
        content_digest: "a".repeat(64),
        mode: "direct",
        tasks: [{ id: "task_one", acceptance: ["legacy prose"] }],
      },
      contexts: [{ record_kind: "context_bundle", task_id: "task_one", digest: "b".repeat(64) }],
      authorization_records: [],
      grant_records: [],
      relied_grant_digests: ["c".repeat(64)],
    });

    expect(assessment).toMatchObject({ required: true, resume_phase: "plan" });
    expect(assessment.reasons).toEqual([
      "execution_kind_missing",
      "atomic_acceptance_missing",
      "task_context_manifest_missing:task_one",
      "execution_authorization_missing",
      "capability_grant_missing",
    ]);
  });

  it("builds a deterministic append-only invalidation without rewriting legacy bytes", () => {
    const input = {
      workflow_operation_id: "workflow_legacy",
      iteration_id: "iteration_legacy",
      plan: {
        content_digest: "a".repeat(64),
        execution_kind: "agent",
        impact_coverage: { status: "incomplete" },
        tasks: [],
      },
      contexts: [],
      authorization_records: [],
      grant_records: [],
      relied_grant_digests: [],
    } as const;
    const assessment = assessOpenIterationMigration(input);
    const first = buildOpenIterationMigrationRecord(input, assessment, "2026-08-16T00:00:00.000Z");
    const second = buildOpenIterationMigrationRecord(input, assessment, "2026-08-16T00:00:00.000Z");
    expect(assessment.resume_phase).toBe("impact");
    expect(first).toEqual(second);
    expect(first.invalidated.plan_digest).toBe("a".repeat(64));
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not migrate a current plan before its normal preflight mints authority", () => {
    expect(
      assessOpenIterationMigration({
        workflow_operation_id: "workflow_current",
        iteration_id: "iteration_current",
        plan: {
          content_digest: "d".repeat(64),
          execution_kind: "agent",
          impact_coverage: { status: "complete" },
          tasks: [
            {
              id: "task_one",
              acceptance: [{ assertion_id: "assertion_one" }],
            },
          ],
        },
        contexts: [
          {
            record_kind: "context_bundle",
            task_id: "task_one",
            digest: "e".repeat(64),
            extensions: { "harness.context": { task_digest: "f".repeat(64) } },
          },
        ],
        authorization_records: [],
        grant_records: [],
        relied_grant_digests: [],
      }),
    ).toMatchObject({ required: false, reasons: [] });
  });
});
