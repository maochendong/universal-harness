import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerRepository,
  canonicalizeJson,
  harnessRootFor,
  resolveHarnessPath,
  sha256Hex,
  transactionRequiredReaderVersion,
  type LifecycleEvent,
} from "@universal-harness-internal/core";

import {
  ARTIFACT_KINDS,
  artifactHref,
  approvalDecisionArtifact,
  buildApprovalDecision,
  createArtifactLinkResolver,
  readArtifactView,
  type ArtifactKind,
  type ArtifactRef,
} from "../../src/index.js";
import { BASELINE, FIXED_NOW, cleanupDirectories, makeProjectRoot } from "../workflow/helpers.js";

afterEach(() => {
  cleanupDirectories();
});

const WORKFLOW_OPERATION_ID = "workflow_ar";
const ITERATION_ID = "iteration_t0001";
const PROJECT_ID = "project_demo";

const semantic = (seed: string): string => sha256Hex(`semantic:${seed}`);

interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

interface FixtureEventSpec {
  readonly eventType: string;
  readonly payload?: Record<string, unknown>;
  readonly protocolVersion?: string;
}

function file(path: string, record: unknown): FixtureFile {
  return { path, content: `${canonicalizeJson(record)}\n` };
}

function digestOf(artifact: FixtureFile): string {
  return sha256Hex(artifact.content);
}

/**
 * Real-Ledger fixture: every artifact lands through an atomic
 * LedgerRepository commit, so its manifest, byte digests and (optional)
 * events are exactly what the production commit points produce.
 */
function makeLedger(tag: string): {
  readonly projectRoot: string;
  readonly commit: (spec: {
    readonly artifacts?: readonly FixtureFile[];
    readonly events?: readonly FixtureEventSpec[];
  }) => Promise<{
    readonly ledger_operation_id: string;
    readonly digest: string;
    readonly sequence: number;
    readonly artifact_digests: readonly string[];
  }>;
} {
  const projectRoot = makeProjectRoot();
  let operationCount = 0;
  let eventSequence = 0;
  let tick = 0;
  const now = (): string => {
    tick += 1;
    return new Date(Date.parse(FIXED_NOW) + tick * 1000).toISOString();
  };
  const commit: (spec: {
    readonly artifacts?: readonly FixtureFile[];
    readonly events?: readonly FixtureEventSpec[];
  }) => Promise<{
    readonly ledger_operation_id: string;
    readonly digest: string;
    readonly sequence: number;
    readonly artifact_digests: readonly string[];
  }> = async (spec) => {
    operationCount += 1;
    const ledgerOperationId = `ledger_${tag}${String(operationCount).padStart(2, "0")}`;
    const events: LifecycleEvent[] = (spec.events ?? []).map((eventSpec) => {
      eventSequence += 1;
      return {
        protocol_version: eventSpec.protocolVersion ?? "1.1.0",
        record_kind: "event",
        event_id: `event_${tag}${String(eventSequence).padStart(2, "0")}`,
        event_type: eventSpec.eventType,
        project_id: PROJECT_ID,
        iteration_id: ITERATION_ID,
        workflow_operation_id: WORKFLOW_OPERATION_ID,
        ledger_operation_id: ledgerOperationId,
        sequence: eventSequence,
        timestamp: now(),
        payload: eventSpec.payload ?? {},
      } as LifecycleEvent;
    });
    const transaction = {
      ledger_operation_id: ledgerOperationId,
      workflow_operation_id: WORKFLOW_OPERATION_ID,
      attempt_id: `attempt_${tag}`,
      expected_baseline: BASELINE,
      artifacts: spec.artifacts ?? [],
      edges: [],
      events,
    };
    const pin = transactionRequiredReaderVersion(transaction);
    const result = await new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
      now,
    }).commit({
      ...transaction,
      ...(pin === undefined ? {} : { required_reader_version: pin }),
    });
    if (result.status !== "committed") throw new Error(`fixture commit did not commit: ${tag}`);
    return result.manifest;
  };
  return { projectRoot, commit };
}

function decisionArtifact(): FixtureFile {
  const record = buildApprovalDecision({
    approvalId: "approval_ar1",
    requestId: "approval-request_ar1",
    actor: "user:alice@example.com",
    decision: "approve",
    objectDigest: semantic("object"),
    decidedAt: FIXED_NOW,
  });
  return approvalDecisionArtifact(record);
}

interface KindFixture {
  readonly scope: "artifact" | "manifest";
  /** Builds the committed files; returns the digest to query with. */
  readonly commit: (
    commit: (spec: {
      readonly artifacts?: readonly FixtureFile[];
      readonly events?: readonly FixtureEventSpec[];
    }) => Promise<{ readonly digest: string }>,
  ) => Promise<string>;
  /** Business facts the safe view must keep. */
  readonly expectContent: (content: Record<string, unknown>) => void;
  /** Raw strings that must never leak into the serialized view. */
  readonly forbidden: readonly string[];
}

const LONG_SUMMARY = `执行摘要：${"迭代完成，所有门禁通过。".repeat(900)}`;

/** One committed fixture per kind; the table is the 15-kind whitelist contract. */
const KIND_FIXTURES: Record<ArtifactKind, KindFixture> = {
  approval_decision: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = decisionArtifact();
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["decision"]).toBe("approve");
      expect(content["actor_display"]).toMatch(/^审批者[0-9a-f]{12}$/u);
    },
    forbidden: ["user:alice@example.com"],
  },
  prd: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file("artifacts/capture/accepted/prd_ar/1.json", {
        protocol_version: "1.1.0",
        record_kind: "accepted_prd",
        prd_id: "prd_ar",
        revision: 1,
        session_id: "capture-session_ar",
        workflow_operation_id: WORKFLOW_OPERATION_ID,
        proposal_id: "prd-proposal_ar",
        proposal_content_digest: semantic("proposal-content"),
        proposal_context_bundle_digest: semantic("proposal-bundle"),
        review_context_bundle_digest: semantic("review-bundle"),
        validation_report_digest: semantic("validation"),
        review_report_digest: semantic("review"),
        risk_assessment_digest: semantic("risk"),
        capture_policy_digest: semantic("capture-policy"),
        policy_digest: semantic("policy"),
        approval_digest: semantic("approval"),
        requirement_baseline_digest: semantic("baseline"),
        record_digest: semantic("prd"),
      });
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["prd_id"]).toBe("prd_ar");
      expect(content["revision"]).toBe(1);
      expect(content["policy_digest"]).toBe(semantic("policy"));
    },
    forbidden: [],
  },
  design_set: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file("artifacts/design-sets/design-set_ar/1.json", {
        protocol_version: "1.1.0",
        record_kind: "node",
        id: "design-set_ar",
        type: "DesignSet",
        revision: 1,
        status: "accepted",
        summary: "订单服务设计基线",
        digest: semantic("design-set"),
        provenance: { actor: "user:designer@example.com", timestamp: FIXED_NOW },
        extensions: {
          "harness.design.set": {
            content_digest: semantic("design-content"),
            approval_digest: semantic("design-approval"),
          },
        },
      });
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["design_set_id"]).toBe("design-set_ar");
      expect(content["summary"]).toBe("订单服务设计基线");
      expect(content["content_digest"]).toBe(semantic("design-content"));
    },
    forbidden: ["user:designer@example.com"],
  },
  plan: {
    scope: "artifact",
    commit: async (commit) => {
      const plan = file("artifacts/plans/plan_ar.json", {
        protocol_version: "1.1.0",
        record_kind: "node",
        id: "plan_ar",
        type: "ExecutionPlan",
        revision: 1,
        status: "accepted",
        summary: "迭代执行计划",
        digest: semantic("plan"),
        extensions: { "harness.plan": { mode: "agent" } },
      });
      const task = file("artifacts/tasks/task_ar1.json", {
        protocol_version: "1.1.0",
        record_kind: "node",
        id: "task_ar1",
        type: "Task",
        revision: 1,
        status: "accepted",
        summary: "实现订单接口",
        digest: semantic("task1"),
      });
      await commit({ artifacts: [plan, task] });
      return digestOf(plan);
    },
    expectContent: (content) => {
      expect(content["plan_id"]).toBe("plan_ar");
      expect(content["summary"]).toBe("迭代执行计划");
      const tasks = content["tasks"] as { items: { task_id: string; summary: string }[] };
      expect(tasks.items).toEqual([{ task_id: "task_ar1", summary: "实现订单接口" }]);
    },
    forbidden: [],
  },
  context_manifest: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file("artifacts/context-bundles/bundle_ar.json", {
        protocol_version: "1.1.0",
        record_kind: "context_bundle",
        context_bundle_id: "bundle_ar",
        task_id: "task_ar1",
        source_digests: [semantic("source-a"), semantic("source-b")],
        digest: semantic("bundle"),
        stale: false,
        extensions: {
          "harness.context": { goal: "实现订单接口", included_tokens: 512, token_budget: 2048 },
        },
      });
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["context_bundle_id"]).toBe("bundle_ar");
      expect(content["task_id"]).toBe("task_ar1");
      expect(content["included_tokens"]).toBe(512);
      expect(content["source_digests"]).toEqual([semantic("source-a"), semantic("source-b")]);
    },
    forbidden: [],
  },
  run_summary: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file("artifacts/run-results/run_ar.json", {
        outcome: "handoff",
        termination_reason: "completion",
        completion_claimed: true,
        summary: "任务完成：订单接口已实现",
        state_proposal: { raw_prompt: "提示词原文不得展示" },
        dropped_proposal_fields: ["secret_notes"],
        change_summary: { files_changed: 1, insertions: 12, deletions: 3, paths: ["src/order.ts"] },
        tool_activity: { total_calls: 2, governed_calls: 2, by_tool: { shell: 2 } },
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          duration_ms: 1200,
          metering: "reported",
        },
        evidence: [
          {
            kind: "harness_diff",
            locator: "repository://repo/run/run_ar",
            digest: semantic("diff"),
          },
        ],
        undeclared_writes: [],
      });
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["outcome"]).toBe("handoff");
      expect(content["summary"]).toBe("任务完成：订单接口已实现");
      expect(content["change_summary"]).toMatchObject({ files_changed: 1 });
      // Unsafe raw fields are listed with a reason, never rendered (spec §10).
      expect(content["omitted"]).toEqual([
        { field: "state_proposal", reason_zh: expect.any(String) },
        { field: "dropped_proposal_fields", reason_zh: expect.any(String) },
      ]);
    },
    forbidden: ["提示词原文不得展示", "secret_notes"],
  },
  gate_result: {
    scope: "artifact",
    commit: async (commit) => {
      const evidenceRecord = file(`artifacts/evidence/evidence_ar/${semantic("evidence")}.json`, {
        protocol_version: "1.1.0",
        record_kind: "evidence",
        evidence_id: "evidence_ar",
        evidence_type: "gate_run",
        subject_id: "task_ar1",
        digest: semantic("evidence"),
        provisional: false,
        created_at: FIXED_NOW,
        extensions: {
          "harness.gate": {
            gate_id: "gate_unit",
            layer: "test",
            mandatory: true,
            passed: true,
            exit_code: 0,
            summary: "单测通过",
            log_summary: "12/12 passed",
            artifact_hashes: {},
            bindings: {
              artifact_digests: [],
              code_digests: [],
              gate_digest: semantic("gate"),
              evaluation_case_digests: [],
              policy_digest: semantic("policy"),
            },
          },
        },
      });
      const summaryRecord = file(`artifacts/verify/${ITERATION_ID}/${semantic("verify")}.json`, {
        record_kind: "orchestration_verify_result",
        iteration_id: ITERATION_ID,
        bindings: { artifact_digests: [], code_digests: [], evaluation_case_digests: [] },
        results: [
          {
            gate_id: "gate_unit",
            passed: true,
            evidence_id: "evidence_ar",
            summary: "单测通过",
          },
        ],
        findings: [],
        completed_allowed: true,
      });
      await commit({ artifacts: [evidenceRecord, summaryRecord] });
      return digestOf(summaryRecord);
    },
    expectContent: (content) => {
      expect(content["completed_allowed"]).toBe(true);
      const results = content["results"] as { items: { gate_id: string; passed: boolean }[] };
      expect(results.items).toEqual([
        { gate_id: "gate_unit", passed: true, evidence_id: "evidence_ar", summary: "单测通过" },
      ]);
    },
    forbidden: [],
  },
  evidence: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file(`artifacts/evidence/evidence_ar/${semantic("evidence")}.json`, {
        protocol_version: "1.1.0",
        record_kind: "evidence",
        evidence_id: "evidence_ar",
        evidence_type: "gate_run",
        subject_id: "task_ar1",
        digest: semantic("evidence"),
        provisional: false,
        created_at: FIXED_NOW,
        extensions: {
          "harness.gate": {
            gate_id: "gate_unit",
            layer: "test",
            mandatory: true,
            passed: false,
            exit_code: 1,
            summary: "单测失败",
            log_summary: "10/12 passed",
            artifact_hashes: {},
            bindings: {
              artifact_digests: [],
              code_digests: [],
              gate_digest: semantic("gate"),
              evaluation_case_digests: [],
              policy_digest: semantic("policy"),
            },
          },
        },
      });
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["evidence_id"]).toBe("evidence_ar");
      expect(content["passed"]).toBe(false);
      expect(content["summary"]).toBe("单测失败");
      expect(content["record_digest"]).toBe(semantic("evidence"));
    },
    forbidden: [],
  },
  evaluation: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file(
        `artifacts/evaluations/evidence_evaluation_ar/${semantic("evaluation")}.json`,
        {
          protocol_version: "1.1.0",
          record_kind: "evidence",
          evidence_id: "evidence_evaluation_ar",
          evidence_type: "evaluation_report",
          subject_id: "task_ar1",
          digest: semantic("evaluation"),
          provisional: false,
          created_at: FIXED_NOW,
          extensions: {
            "harness.evaluation": {
              case_id: "case_ar1",
              case_digest: semantic("case"),
              passed: true,
              visibility: "external-only",
            },
          },
        },
      );
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["evaluation_id"]).toBe("evidence_evaluation_ar");
      expect(content["case_id"]).toBe("case_ar1");
      expect(content["passed"]).toBe(true);
    },
    forbidden: [],
  },
  snapshot: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file("artifacts/snapshots/snapshot_ar.json", {
        protocol_version: "1.1.0",
        record_kind: "snapshot",
        snapshot_id: "snapshot_ar",
        iteration_id: ITERATION_ID,
        status: "completed",
        final_commit: BASELINE,
        workflow_operation_id: WORKFLOW_OPERATION_ID,
        created_at: FIXED_NOW,
        run_outcomes: [{ id: "run_ar", outcome: "handoff" }],
        task_verdicts: [{ task_id: "task_ar1", verdict: "passed" }],
        approvals: [],
        evidence: [],
        closed_findings: [],
        unresolved_items: [],
        rejected_hypotheses: [],
        trajectory_summary: "原始轨迹不得展示",
        coverage_summary: "门禁全部通过",
      });
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["snapshot_id"]).toBe("snapshot_ar");
      expect(content["status"]).toBe("completed");
      expect(content["task_verdicts"]).toEqual({
        items: [{ task_id: "task_ar1", verdict: "passed" }],
        total: 1,
      });
    },
    forbidden: ["原始轨迹不得展示"],
  },
  tdd_artifact: {
    scope: "artifact",
    commit: async (commit) => {
      const cycle = file("artifacts/tdd-cycles/cycle_ar-1.json", {
        protocol_version: "1.1.0",
        record_kind: "tdd_cycle",
        logical_cycle_id: "cycle_ar",
        attempt_ordinal: 1,
        task_id: "task_ar1",
        status: "completed",
        assertion_ids: ["assert_ar1"],
        contract_digest: semantic("contract"),
        repository_baseline: BASELINE,
        record_digest: semantic("cycle"),
      });
      const evidenceRecord = file(
        `artifacts/tdd-evidence/cycle_ar-1-red-${semantic("tdd-evidence").slice(0, 12)}.json`,
        {
          record_kind: "tdd_evidence",
          evidence_type: "red",
          task_id: "task_ar1",
          contract_digest: semantic("contract"),
          logical_cycle_id: "cycle_ar",
          attempt_ordinal: 1,
          digest: semantic("tdd-evidence"),
        },
      );
      const grant = file(`artifacts/tdd-grants/${semantic("grant")}.json`, {
        record_kind: "capability_grant",
        grant_id: "grant_ar1",
        task_id: "task_ar1",
        phase: "implementation",
        digest: semantic("grant"),
      });
      await commit({ artifacts: [cycle, evidenceRecord, grant] });
      return digestOf(cycle);
    },
    expectContent: (content) => {
      const cycle = content["cycle"] as Record<string, unknown>;
      expect(cycle["logical_cycle_id"]).toBe("cycle_ar");
      expect(cycle["status"]).toBe("completed");
      const evidence = content["evidence"] as { items: { evidence_type: string }[] };
      expect(evidence.items).toEqual([{ evidence_type: "red", digest: semantic("tdd-evidence") }]);
      const grants = content["grants"] as { grant_id: string }[];
      expect(grants).toEqual([
        { grant_id: "grant_ar1", phase: "implementation", digest: semantic("grant") },
      ]);
    },
    forbidden: [],
  },
  finding_group: {
    scope: "manifest",
    commit: async (commit) => {
      const finding = file("artifacts/findings/finding_ar/proposed.json", {
        protocol_version: "1.1.0",
        record_kind: "feedback",
        id: "finding_ar",
        type: "Finding",
        iteration_id: ITERATION_ID,
        status: "proposed",
        summary: "缺少验证证据",
        created_at: FIXED_NOW,
        digest: semantic("finding"),
        extensions: {
          "harness.finding": {
            rule: "missing_verification",
            scope_prefix: "project/demo/verification",
            severity: "warning",
            actionability: "human_review",
          },
        },
      });
      const manifest = await commit({ artifacts: [finding] });
      return manifest.digest;
    },
    expectContent: (content) => {
      const findings = content["findings"] as {
        items: { finding_id: string; status: string; summary: string; rule?: string }[];
        total: number;
      };
      expect(findings.items).toEqual([
        {
          finding_id: "finding_ar",
          status: "proposed",
          summary: "缺少验证证据",
          rule: "missing_verification",
          severity: "warning",
        },
      ]);
      expect(findings.total).toBe(1);
    },
    forbidden: [],
  },
  wave_result: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file(
        `artifacts/scheduling/${WORKFLOW_OPERATION_ID}/waves/wave-integration_ar.json`,
        {
          protocol_version: "1.3.0",
          record_kind: "wave_integration",
          wave_integration_id: "wave-integration_ar",
          operation_id: WORKFLOW_OPERATION_ID,
          iteration_id: ITERATION_ID,
          plan_digest: semantic("plan"),
          wave_index: 0,
          task_ids: ["task_ar1", "task_ar2"],
          base_commit: BASELINE,
          candidate_commit: BASELINE.slice(0, 40),
          accepted_source_tree_digest: semantic("tree"),
          task_lease_digests: [],
          task_evidence_digests: [],
          candidate_gate_evidence_digests: [],
          wave_gate_evidence_digests: [],
          policy_digest: semantic("policy"),
          approval_digests: [],
          command_id: "command_ar1",
          integrated_at: FIXED_NOW,
          record_digest: semantic("wave"),
        },
      );
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["wave_integration_id"]).toBe("wave-integration_ar");
      expect(content["wave_index"]).toBe(0);
      expect(content["task_ids"]).toEqual(["task_ar1", "task_ar2"]);
    },
    forbidden: [],
  },
  integration_record: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file("artifacts/integrations/integration_ar.json", {
        record_kind: "integration",
        integration_id: "integration_ar",
        operation_id: WORKFLOW_OPERATION_ID,
        expected_target_commit: BASELINE,
        operation_commit: BASELINE,
        lease_fencing_token: 3,
        ledger_sequence_rewrites: [],
        evidence_digests: [],
        approval_decision_digests: [],
        command_id: "command_ar1",
        record_digest: semantic("integration"),
      });
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["integration_id"]).toBe("integration_ar");
      expect(content["operation_id"]).toBe(WORKFLOW_OPERATION_ID);
      expect(content["record_digest"]).toBe(semantic("integration"));
    },
    forbidden: [],
  },
  task_lease: {
    scope: "artifact",
    commit: async (commit) => {
      const artifact = file(
        `artifacts/scheduling/${WORKFLOW_OPERATION_ID}/leases/task-lease-record_ar.json`,
        {
          protocol_version: "1.3.0",
          record_kind: "task_lease",
          task_lease_record_id: "task-lease-record_ar",
          lease_id: "lease_ar",
          operation_id: WORKFLOW_OPERATION_ID,
          task_id: "task_ar1",
          slot_id: "slot_ar",
          fencing_token: 7,
          state: "granted",
          reserved_budget: { steps: 10, tokens: 1000 },
          retry_kind: "none",
          approval_digests: [],
          granted_at: FIXED_NOW,
          record_digest: semantic("lease"),
        },
      );
      await commit({ artifacts: [artifact] });
      return digestOf(artifact);
    },
    expectContent: (content) => {
      expect(content["lease_id"]).toBe("lease_ar");
      expect(content["task_id"]).toBe("task_ar1");
      expect(content["fencing_token"]).toBe(7);
      expect(content["state"]).toBe("granted");
    },
    forbidden: [],
  },
};

describe("readArtifactView", () => {
  it.each(ARTIFACT_KINDS)(
    "reads the committed %s at its pinned byte digest with a safe view",
    async (kind) => {
      const fixture = KIND_FIXTURES[kind];
      const ledger = makeLedger(`k${kind.replace(/_[a-z]/gu, "").slice(0, 6)}`);
      const digest = await fixture.commit(ledger.commit);

      const view = await readArtifactView(ledger.projectRoot, {
        kind,
        scope: fixture.scope,
        digest,
      });

      expect(view.ref).toEqual({ kind, scope: fixture.scope, digest });
      expect(view.safe_view).toBe(true);
      expect(view.provenance.ledger_operation_id).toMatch(/^ledger_/u);
      expect(view.provenance.manifest_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(Array.isArray(view.provenance.input_refs)).toBe(true);
      fixture.expectContent(view.content as Record<string, unknown>);
      const serialized = JSON.stringify(view);
      for (const forbidden of fixture.forbidden) {
        expect(serialized).not.toContain(forbidden);
      }
    },
  );

  it("opens the old version when the same object was committed twice", async () => {
    const ledger = makeLedger("tv");
    const oldArtifact = file(`artifacts/evidence/evidence_tv/${semantic("old")}.json`, {
      protocol_version: "1.1.0",
      record_kind: "evidence",
      evidence_id: "evidence_tv",
      evidence_type: "gate_run",
      subject_id: "task_ar1",
      digest: semantic("old"),
      provisional: false,
      created_at: FIXED_NOW,
      extensions: {
        "harness.gate": { gate_id: "gate_unit", passed: false, summary: "旧版本未通过" },
      },
    });
    await ledger.commit({ artifacts: [oldArtifact] });
    const newArtifact = file(`artifacts/evidence/evidence_tv/${semantic("new")}.json`, {
      protocol_version: "1.1.0",
      record_kind: "evidence",
      evidence_id: "evidence_tv",
      evidence_type: "gate_run",
      subject_id: "task_ar1",
      digest: semantic("new"),
      provisional: false,
      created_at: FIXED_NOW,
      extensions: {
        "harness.gate": { gate_id: "gate_unit", passed: true, summary: "新版本已通过" },
      },
    });
    await ledger.commit({ artifacts: [newArtifact] });

    const view = await readArtifactView(ledger.projectRoot, {
      kind: "evidence",
      scope: "artifact",
      digest: digestOf(oldArtifact),
    });

    expect(view.ref.digest).toBe(digestOf(oldArtifact));
    expect(view.ref.digest).not.toBe(digestOf(newArtifact));
    expect((view.content as Record<string, unknown>)["summary"]).toBe("旧版本未通过");
  });

  it("rejects unknown kinds, malformed digests and disallowed kind/scope pairs", async () => {
    const ledger = makeLedger("iq");
    const committed = await KIND_FIXTURES["evidence"].commit(ledger.commit);

    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "raw_log" as ArtifactKind,
        scope: "artifact",
        digest: committed,
      }),
    ).rejects.toMatchObject({ kind: "invalid_artifact_query" });
    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "evidence",
        scope: "artifact",
        digest: "not-a-digest",
      }),
    ).rejects.toMatchObject({ kind: "invalid_artifact_query" });
    // finding_group is a derived manifest-scope view; artifact scope is not allowed.
    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "finding_group",
        scope: "artifact",
        digest: committed,
      }),
    ).rejects.toMatchObject({ kind: "invalid_artifact_query" });
    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "evidence",
        scope: "manifest",
        digest: committed,
      }),
    ).rejects.toMatchObject({ kind: "invalid_artifact_query" });
  });

  it("reports a digest no committed manifest carries as not found", async () => {
    const ledger = makeLedger("nf");
    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "evidence",
        scope: "artifact",
        digest: semantic("never-committed"),
      }),
    ).rejects.toMatchObject({ kind: "artifact_not_found" });
  });

  it("never trusts an uncommitted file dropped into the artifact tree", async () => {
    const ledger = makeLedger("uc");
    const harnessRoot = harnessRootFor(ledger.projectRoot);
    const artifact = file(`artifacts/evidence/evidence_uc/${semantic("uc")}.json`, {
      protocol_version: "1.1.0",
      record_kind: "evidence",
      evidence_id: "evidence_uc",
      evidence_type: "gate_run",
      subject_id: "task_ar1",
      digest: semantic("uc"),
      provisional: false,
      created_at: FIXED_NOW,
    });
    mkdirSync(resolveHarnessPath(harnessRoot, "artifacts/evidence/evidence_uc"), {
      recursive: true,
    });
    writeFileSync(resolveHarnessPath(harnessRoot, artifact.path), artifact.content);

    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "evidence",
        scope: "artifact",
        digest: digestOf(artifact),
      }),
    ).rejects.toMatchObject({ kind: "artifact_not_found" });
  });

  it("fails closed when committed bytes were replaced or removed", async () => {
    const ledger = makeLedger("tp");
    const digest = await KIND_FIXTURES["evidence"].commit(ledger.commit);
    const harnessRoot = harnessRootFor(ledger.projectRoot);
    writeFileSync(
      resolveHarnessPath(
        harnessRoot,
        `artifacts/evidence/evidence_ar/${semantic("evidence")}.json`,
      ),
      `${JSON.stringify({ tampered: true })}\n`,
    );
    await expect(
      readArtifactView(ledger.projectRoot, { kind: "evidence", scope: "artifact", digest }),
    ).rejects.toMatchObject({ kind: "artifact_corrupt" });

    const missing = makeLedger("ms");
    const missingDigest = await KIND_FIXTURES["evidence"].commit(missing.commit);
    writeFileSync(
      resolveHarnessPath(
        harnessRootFor(missing.projectRoot),
        `artifacts/evidence/evidence_ar/${semantic("evidence")}.json`,
      ),
      "",
    );
    await expect(
      readArtifactView(missing.projectRoot, {
        kind: "evidence",
        scope: "artifact",
        digest: missingDigest,
      }),
    ).rejects.toMatchObject({ kind: "artifact_corrupt" });
  });

  it("rejects a committed digest presented under a disguised kind", async () => {
    const ledger = makeLedger("ks");
    const digest = await KIND_FIXTURES["evidence"].commit(ledger.commit);
    await expect(
      readArtifactView(ledger.projectRoot, { kind: "plan", scope: "artifact", digest }),
    ).rejects.toMatchObject({ kind: "artifact_corrupt" });
  });

  it("never follows a symlink that escapes the harness root", async () => {
    const ledger = makeLedger("sl");
    const harnessRoot = harnessRootFor(ledger.projectRoot);
    const outside = `${makeProjectRoot()}/outside.json`;
    writeFileSync(outside, `${JSON.stringify({ record_kind: "evidence", secret: true })}\n`);
    mkdirSync(resolveHarnessPath(harnessRoot, "artifacts/evidence/evidence_sl"), {
      recursive: true,
    });
    symlinkSync(
      outside,
      resolveHarnessPath(harnessRoot, "artifacts/evidence/evidence_sl/escape.json"),
    );

    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "evidence",
        scope: "artifact",
        digest: sha256Hex(`${JSON.stringify({ record_kind: "evidence", secret: true })}\n`),
      }),
    ).rejects.toMatchObject({ kind: "artifact_not_found" });
  });

  it("keeps manifest digests, byte digests and semantic record digests apart", async () => {
    const ledger = makeLedger("dg");
    const artifact = file(`artifacts/evidence/evidence_dg/${semantic("dg")}.json`, {
      protocol_version: "1.1.0",
      record_kind: "evidence",
      evidence_id: "evidence_dg",
      evidence_type: "gate_run",
      subject_id: "task_ar1",
      digest: semantic("dg"),
      provisional: false,
      created_at: FIXED_NOW,
    });
    const manifest = await ledger.commit({ artifacts: [artifact] });

    // The manifest digest is not an artifact address.
    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "evidence",
        scope: "artifact",
        digest: manifest.digest,
      }),
    ).rejects.toMatchObject({ kind: "artifact_not_found" });
    // The record's semantic digest is not the byte digest either.
    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "evidence",
        scope: "artifact",
        digest: semantic("dg"),
      }),
    ).rejects.toMatchObject({ kind: "artifact_not_found" });
    // A byte digest is not a manifest address.
    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "finding_group",
        scope: "manifest",
        digest: digestOf(artifact),
      }),
    ).rejects.toMatchObject({ kind: "artifact_not_found" });
  });

  it("redacts resolved secret values and never renders raw actor identities", async () => {
    process.env["HARNESS_ARTIFACT_READER_TEST_SECRET"] = "s3cret-token-value";
    try {
      const ledger = makeLedger("sr");
      const artifact = file("artifacts/run-results/run_sr.json", {
        outcome: "failed",
        termination_reason: "adapter_failure",
        completion_claimed: false,
        summary: `命令失败，令牌为 s3cret-token-value，联系人 admin@example.com`,
        state_proposal: null,
        dropped_proposal_fields: [],
        change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
        tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
        usage: {
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          duration_ms: 5,
          metering: "unmetered",
        },
        evidence: [],
        undeclared_writes: [],
        credentials: { $env: "HARNESS_ARTIFACT_READER_TEST_SECRET" },
      });
      const digest = digestOf(artifact);
      await ledger.commit({ artifacts: [artifact] });

      const view = await readArtifactView(ledger.projectRoot, {
        kind: "run_summary",
        scope: "artifact",
        digest,
      });
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("s3cret-token-value");
      expect(serialized).toContain("[redacted:secret]");
      expect(serialized).not.toContain("credentials");
    } finally {
      delete process.env["HARNESS_ARTIFACT_READER_TEST_SECRET"];
    }
  });

  it("pages long text fields in 8 KiB UTF-8-safe fragments without moving the digest", async () => {
    const ledger = makeLedger("lt");
    const artifact = file("artifacts/run-results/run_lt.json", {
      outcome: "handoff",
      termination_reason: "completion",
      completion_claimed: true,
      summary: LONG_SUMMARY,
      state_proposal: null,
      dropped_proposal_fields: [],
      change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
      tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        duration_ms: 5,
        metering: "unmetered",
      },
      evidence: [],
      undeclared_writes: [],
    });
    const digest = digestOf(artifact);
    await ledger.commit({ artifacts: [artifact] });
    expect(Buffer.byteLength(LONG_SUMMARY, "utf8")).toBeGreaterThan(8 * 1024);

    const first = await readArtifactView(ledger.projectRoot, {
      kind: "run_summary",
      scope: "artifact",
      digest,
    });
    const firstContent = first.content as {
      summary: string;
      summary_fragment: { truncated: boolean; total_bytes: number };
    };
    expect(first.ref.digest).toBe(digest);
    expect(Buffer.byteLength(firstContent.summary, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(firstContent.summary_fragment.truncated).toBe(true);
    expect(firstContent.summary_fragment.total_bytes).toBe(Buffer.byteLength(LONG_SUMMARY, "utf8"));
    expect(first.next_cursor).toBeDefined();

    let assembled = firstContent.summary;
    let cursor = first.next_cursor;
    let pages = 0;
    while (cursor !== undefined) {
      pages += 1;
      const next = await readArtifactView(ledger.projectRoot, {
        kind: "run_summary",
        scope: "artifact",
        digest,
        cursor,
      });
      expect(next.ref.digest).toBe(digest);
      const content = next.content as { summary: string };
      expect(Buffer.byteLength(content.summary, "utf8")).toBeLessThanOrEqual(8 * 1024);
      assembled += content.summary;
      cursor = next.next_cursor;
    }
    expect(pages).toBeGreaterThan(0);
    expect(assembled).toBe(LONG_SUMMARY);
  });

  it("pages collections with limit 1..100, default 20, and a stable digest", async () => {
    const ledger = makeLedger("pg");
    const results = Array.from({ length: 25 }, (_, index) => ({
      gate_id: `gate_${String(index).padStart(2, "0")}`,
      passed: index % 2 === 0,
      evidence_id: `evidence_${String(index).padStart(2, "0")}`,
      summary: `门禁 ${String(index)}`,
    }));
    const artifact = file(`artifacts/verify/${ITERATION_ID}/${semantic("verify25")}.json`, {
      record_kind: "orchestration_verify_result",
      iteration_id: ITERATION_ID,
      bindings: { artifact_digests: [], code_digests: [], evaluation_case_digests: [] },
      results,
      findings: [],
      completed_allowed: false,
    });
    const digest = digestOf(artifact);
    await ledger.commit({ artifacts: [artifact] });

    const firstPage = await readArtifactView(ledger.projectRoot, {
      kind: "gate_result",
      scope: "artifact",
      digest,
    });
    const firstContent = firstPage.content as {
      results: { items: { gate_id: string }[]; total: number };
    };
    expect(firstContent.results.items).toHaveLength(20);
    expect(firstContent.results.total).toBe(25);
    expect(firstPage.next_cursor).toBeDefined();

    const secondPage = await readArtifactView(ledger.projectRoot, {
      kind: "gate_result",
      scope: "artifact",
      digest,
      cursor: firstPage.next_cursor,
    });
    expect(secondPage.ref.digest).toBe(digest);
    const secondContent = secondPage.content as { results: { items: { gate_id: string }[] } };
    expect(secondContent.results.items).toHaveLength(5);
    expect(secondPage.next_cursor).toBeUndefined();

    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "gate_result",
        scope: "artifact",
        digest,
        limit: 0,
      }),
    ).rejects.toMatchObject({ kind: "invalid_artifact_query" });
    await expect(
      readArtifactView(ledger.projectRoot, {
        kind: "gate_result",
        scope: "artifact",
        digest,
        limit: 101,
      }),
    ).rejects.toMatchObject({ kind: "invalid_artifact_query" });

    const bounded = await readArtifactView(ledger.projectRoot, {
      kind: "gate_result",
      scope: "artifact",
      digest,
      limit: 3,
    });
    expect((bounded.content as { results: { items: unknown[] } }).results.items).toHaveLength(3);
  });

  it("returns an empty collection view for a manifest without matching sources", async () => {
    const ledger = makeLedger("em");
    const manifest = await ledger.commit({ artifacts: [] });

    const view = await readArtifactView(ledger.projectRoot, {
      kind: "finding_group",
      scope: "manifest",
      digest: manifest.digest,
    });

    expect(view.ref.digest).toBe(manifest.digest);
    expect((view.content as { findings: { items: unknown[] } }).findings.items).toEqual([]);
    expect(view.provenance.input_refs).toEqual([]);
    expect(view.next_cursor).toBeUndefined();
  });

  it("binds a derived finding group to the complete committed input set", async () => {
    const ledger = makeLedger("fg");
    const finding = file("artifacts/findings/finding_fg/proposed.json", {
      protocol_version: "1.1.0",
      record_kind: "feedback",
      id: "finding_fg",
      type: "Finding",
      iteration_id: ITERATION_ID,
      status: "proposed",
      summary: "缺少验证证据",
      created_at: FIXED_NOW,
      digest: semantic("finding-fg"),
      extensions: { "harness.finding": { rule: "missing_verification" } },
    });
    const evidenceRecord = file(`artifacts/evidence/evidence_fg/${semantic("evidence-fg")}.json`, {
      protocol_version: "1.1.0",
      record_kind: "evidence",
      evidence_id: "evidence_fg",
      evidence_type: "gate_run",
      subject_id: "task_ar1",
      digest: semantic("evidence-fg"),
      provisional: false,
      created_at: FIXED_NOW,
    });
    const manifest = await ledger.commit({ artifacts: [finding, evidenceRecord] });

    const view = await readArtifactView(ledger.projectRoot, {
      kind: "finding_group",
      scope: "manifest",
      digest: manifest.digest,
    });

    expect(view.provenance.manifest_digest).toBe(manifest.digest);
    const content = view.content as { findings: { items: { finding_id: string }[] } };
    expect(content.findings.items.map((item) => item.finding_id)).toEqual(["finding_fg"]);
    expect(view.provenance.input_refs).toEqual([
      { kind: "evidence", scope: "artifact", digest: digestOf(evidenceRecord) },
    ]);
  });
});

describe("artifactHref", () => {
  it("builds a same-origin read-only URL from the whitelisted parts only", () => {
    const ref: ArtifactRef = { kind: "plan", scope: "artifact", digest: semantic("p") };
    expect(artifactHref(ref)).toBe(`/api/v1/artifacts/${semantic("p")}?kind=plan&scope=artifact`);
  });
});

describe("createArtifactLinkResolver", () => {
  function eventOf(
    eventType: string,
    payload: Record<string, unknown>,
    ledgerOperationId: string,
  ): LifecycleEvent {
    return {
      protocol_version: "1.4.0",
      record_kind: "event",
      event_id: "event_link1",
      event_type: eventType,
      project_id: PROJECT_ID,
      iteration_id: ITERATION_ID,
      workflow_operation_id: WORKFLOW_OPERATION_ID,
      ledger_operation_id: ledgerOperationId,
      sequence: 1,
      timestamp: FIXED_NOW,
      payload,
    } as LifecycleEvent;
  }

  it("links an ArtifactAvailable event to its committed artifact", async () => {
    const ledger = makeLedger("la");
    const plan = file("artifacts/plans/plan_la.json", {
      protocol_version: "1.1.0",
      record_kind: "node",
      id: "plan_la",
      type: "ExecutionPlan",
      revision: 1,
      status: "accepted",
      summary: "计划",
      digest: semantic("plan-la"),
    });
    const manifest = await ledger.commit({ artifacts: [plan] });
    const resolver = createArtifactLinkResolver(ledger.projectRoot);

    const links = resolver.linksForEvent(
      eventOf(
        "ArtifactAvailable",
        { artifact_kind: "plan", record_digest: digestOf(plan), summary: "计划已提交" },
        manifest.ledger_operation_id,
      ),
    );

    expect(links).toEqual([
      {
        label_zh: "查看对应版本产出",
        ref: { kind: "plan", scope: "artifact", digest: digestOf(plan) },
        href: artifactHref({ kind: "plan", scope: "artifact", digest: digestOf(plan) }),
      },
    ]);
  });

  it("links PlanAccepted to the pinned plan version, never the newest", async () => {
    const ledger = makeLedger("lp");
    const plan = file("artifacts/plans/plan_lp.json", {
      protocol_version: "1.1.0",
      record_kind: "node",
      id: "plan_lp",
      type: "ExecutionPlan",
      revision: 1,
      status: "accepted",
      summary: "计划 v1",
      digest: semantic("plan-lp"),
    });
    await ledger.commit({ artifacts: [plan] });
    const resolver = createArtifactLinkResolver(ledger.projectRoot);

    const links = resolver.linksForEvent(
      eventOf("PlanAccepted", { plan_id: "plan_lp", mode: "agent", tasks: 1 }, "ledger_other"),
    );
    expect(links.map((link) => link.ref)).toEqual([
      { kind: "plan", scope: "artifact", digest: digestOf(plan) },
    ]);
  });

  it("links ApprovalDecided to the committed decision bytes", async () => {
    const ledger = makeLedger("ld");
    const artifact = decisionArtifact();
    await ledger.commit({ artifacts: [artifact] });
    const resolver = createArtifactLinkResolver(ledger.projectRoot);

    const links = resolver.linksForEvent(
      eventOf(
        "ApprovalDecided",
        {
          request_id: "approval-request_ar1",
          approval_id: "approval_ar1",
          decision: "approve",
          object_digest: semantic("object"),
          decision_digest: digestOf(artifact),
          decided_at: FIXED_NOW,
        },
        "ledger_decision",
      ),
    );
    expect(links.map((link) => link.ref)).toEqual([
      { kind: "approval_decision", scope: "artifact", digest: digestOf(artifact) },
    ]);
  });

  it("resolves same-transaction artifacts through the event's own manifest", async () => {
    const ledger = makeLedger("lm");
    const lease = file(
      `artifacts/scheduling/${WORKFLOW_OPERATION_ID}/leases/task-lease-record_lm.json`,
      {
        protocol_version: "1.3.0",
        record_kind: "task_lease",
        task_lease_record_id: "task-lease-record_lm",
        lease_id: "lease_lm",
        operation_id: WORKFLOW_OPERATION_ID,
        task_id: "task_ar1",
        slot_id: "slot_ar",
        fencing_token: 1,
        state: "granted",
        record_digest: semantic("lease-lm"),
      },
    );
    const manifest = await ledger.commit({ artifacts: [lease] });
    const resolver = createArtifactLinkResolver(ledger.projectRoot);

    const links = resolver.linksForEvent(
      eventOf(
        "TaskLeaseGranted",
        { operation_id: WORKFLOW_OPERATION_ID, task_id: "task_ar1", lease_id: "lease_lm" },
        manifest.ledger_operation_id,
      ),
    );
    expect(links.map((link) => link.ref)).toEqual([
      { kind: "task_lease", scope: "artifact", digest: digestOf(lease) },
    ]);
  });

  it("emits no link for digests no committed manifest carries", async () => {
    const ledger = makeLedger("lx");
    await ledger.commit({ artifacts: [] });
    const resolver = createArtifactLinkResolver(ledger.projectRoot);
    expect(
      resolver.linksForEvent(
        eventOf(
          "ArtifactAvailable",
          { artifact_kind: "plan", record_digest: semantic("forged"), summary: "伪造" },
          "ledger_x",
        ),
      ),
    ).toEqual([]);
  });
});
