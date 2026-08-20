import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CaptureApprovalDecisionView } from "../../src/capture/commands.js";
import { createPrdCaptureCoordinator } from "../../src/capture/coordinator.js";
import { createCaptureAcceptanceStageHandler } from "../../src/acceptance/commit.js";
import { createCaptureModelProviderBindingRecord } from "../../src/profile/records.js";
import { submitCaptureModelProviderBindings } from "../../src/profile/store.js";
import { createCaptureRiskStageHandlers, type CaptureRiskPolicy } from "../../src/risk/stages.js";
import { readCaptureRiskAssessments } from "../../src/risk/store.js";
import { readPrdProposalRevisions, readPrdValidationReports } from "../../src/proposal/store.js";
import { readPrdReviewReports } from "../../src/review/store.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import type { CaptureSessionRecord } from "../../src/schema/capture.js";
import type { ApprovalBriefOutput } from "../../src/schema/synthesis.js";
import {
  approvalBriefProposalLocator,
  buildCaptureApprovalPreview,
  readApprovalBriefBundle,
  readApprovalBriefRecord,
} from "../../src/synthesis/approval-brief.js";
import { createCaptureApprovalBriefStageHandler } from "../../src/synthesis/approval-brief-stage.js";
import { createInMemoryGroundedSynthesisAdapter } from "../../src/synthesis/in-memory.js";
import type { GroundedSynthesisResult } from "../../src/synthesis/port.js";
import type { ApprovalBriefInput } from "../../src/schema/synthesis.js";
import { makeSession, makeValidDraft } from "../proposal/helpers.js";
import { makeReviewPipelineHandlers, startCommandFor } from "../review/pipeline.js";

/**
 * T7 approval_brief tests (model advisory design 10/11.1, intent-to-prd design
 * 7.5): the brief consumes only the T2 Capture-scope binding, binds the
 * committed approval object, cites per claim, and never modifies the object
 * digest, the risk fields or the approval route. A missing required provider
 * or exhausted retries land in the typed `approval_brief_provider_required`
 * blocker.
 */
const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-approval-brief-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const BASELINE = "0".repeat(64);
const POLICY_DIGEST = "9".repeat(64);
const MATERIAL_POLICY: CaptureRiskPolicy = {
  project_id: "project_demo",
  profile_id: "standard",
  allow_policy_auto_approval: false,
  policy_actor: "policy:capture-standard@1",
};

/** Commit the T2 Capture-scope binding covering approval_brief. */
function commitBriefBinding(root: string, session: CaptureSessionRecord): string {
  const record = createCaptureModelProviderBindingRecord({
    project_id: "project_demo",
    profile_decision_id: "profile-decision_test",
    profile_decision_digest: session.profile_decision_digest,
    policy_digest: session.capture_policy_digest,
    config_digest: "5".repeat(64),
    baseline_digest: session.project_baseline_digest,
    bindings: [
      {
        slot_id: "grounded_synthesis",
        purpose: "approval_brief",
        required: true,
        provider_identity: "provider_fake",
        config_digest: "5".repeat(64),
        prompt_version: "approval-brief-prompt.v1",
        schema_version: "approval-brief.v1",
        budget_profile: "capture-standard",
        failure_mode: "block",
      },
    ],
  });
  submitCaptureModelProviderBindings(root, record);
  return record.record_digest;
}

function briefOutputFor(input: ApprovalBriefInput): ApprovalBriefOutput {
  const source = input.bundle.sources[0]!;
  const ref = { locator: source.locator, source_digest: source.source_digest };
  return {
    purpose: "approval_brief",
    schema_version: "approval-brief.v1",
    bundle_digest: input.bundle.record_digest,
    changes: [{ summary: "新增月度报表 CSV 导出。", source_refs: [ref] }],
    risks: [{ summary: "导出数据范围以审批对象为准。", source_refs: [ref] }],
    tradeoffs: [{ summary: "同步生成换取实现简单。", source_refs: [ref] }],
    open_questions: [],
  };
}

function makeBriefPipeline(
  root: string,
  options: {
    readonly briefHandler?: (input: ApprovalBriefInput) => GroundedSynthesisResult;
    readonly maxRetries?: number;
  } = {},
) {
  const session = makeSession();
  const bindingDigest = commitBriefBinding(root, session);
  const briefAdapter = createInMemoryGroundedSynthesisAdapter(
    options.briefHandler ??
      ((input) => ({
        status: "completed" as const,
        output: briefOutputFor(input as ApprovalBriefInput),
      })),
  );
  const pipeline = makeReviewPipelineHandlers(root, { proposalDrafts: [makeValidDraft] });
  const risk = createCaptureRiskStageHandlers({
    projectRoot: root,
    policy: MATERIAL_POLICY,
    policy_digest: POLICY_DIGEST,
  });
  const brief = createCaptureApprovalBriefStageHandler({
    projectRoot: root,
    port: briefAdapter,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
  const accept = createCaptureAcceptanceStageHandler({
    projectRoot: root,
    readBaseline: () => BASELINE,
    policy_digest: POLICY_DIGEST,
    now: () => "2026-08-19T12:00:00.000Z",
  });
  const handlers = {
    ...pipeline.handlers,
    assessRisk: risk.assessRisk,
    approvalBrief: brief,
    accept,
  };
  return { session, handlers, briefAdapter, bindingDigest };
}

class FakeApprovalDecisions {
  private readonly decisions = new Map<string, CaptureApprovalDecisionView>();

  put(decision: CaptureApprovalDecisionView): void {
    this.decisions.set(`${decision.request_id}/${decision.decision_id}`, decision);
  }

  read = (requestId: string, decisionId: string): CaptureApprovalDecisionView | undefined =>
    this.decisions.get(`${requestId}/${decisionId}`);
}

describe("capture approval_brief", () => {
  it("binds the committed approval object and cites every claim before human approval", async () => {
    const root = makeRoot();
    const { session, handlers, briefAdapter, bindingDigest } = makeBriefPipeline(root);
    const decisions = new FakeApprovalDecisions();
    const coordinator = createPrdCaptureCoordinator({
      projectRoot: root,
      handlers,
      readApprovalDecision: decisions.read,
    });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("awaiting_approval");

    // Exactly one brief invocation, bound to the T2 Capture-scope binding and
    // the committed approval object.
    expect(briefAdapter.invocations).toHaveLength(1);
    const input = briefAdapter.invocations[0] as ApprovalBriefInput;
    expect(input.purpose).toBe("approval_brief");
    expect(input.binding_digest).toBe(bindingDigest);
    const proposal = readPrdProposalRevisions(root, session.session_id).at(-1)!;
    const risk = readCaptureRiskAssessments(root, session.session_id).at(-1)!;
    expect(input.approval_object.proposal_content_digest).toBe(proposal.content_digest);
    expect(input.approval_object.risk_assessment_digest).toBe(risk.assessment_digest);
    if (outcome.status !== "awaiting_approval") throw new Error("expected approval");
    expect(input.approval_object.approval_request_id).toBe(outcome.approval_request_id);

    // The summary never enters the approved object: the proposal digest is
    // exactly what the reviewer saw, and the risk record is untouched.
    expect(outcome.approval_object_digest).toBe(proposal.content_digest);

    // The record and the bundle are committed; the preview attaches the brief.
    const record = readApprovalBriefRecord(root, session.session_id);
    const bundle = readApprovalBriefBundle(root, session.session_id);
    expect(record?.purpose).toBe("approval_brief");
    expect(bundle?.purpose).toBe("approval_brief");
    expect(
      bundle?.sources.some(
        (source) =>
          source.locator === approvalBriefProposalLocator(proposal.content_digest) &&
          source.source_digest === proposal.record_digest,
      ),
    ).toBe(true);

    const preview = buildCaptureApprovalPreview({
      proposal,
      validation_report: readPrdValidationReports(root, session.session_id).at(-1)!,
      review_report: readPrdReviewReports(root, session.session_id).at(-1)!,
      risk_assessment: risk,
      ...(bundle === undefined ? {} : { bundle }),
      ...(record === undefined ? {} : { brief: record }),
    });
    expect(preview.brief_status).toBe("attached");
    expect(preview.object.proposal_content_digest).toBe(proposal.content_digest);
    expect(preview.risk.assessment_digest).toBe(risk.assessment_digest);
    expect(preview.brief?.changes[0]?.source_refs[0]?.locator).toBe(
      input.bundle.sources[0]!.locator,
    );

    // The human approval path still works after the brief.
    const decision: CaptureApprovalDecisionView = {
      decision_id: "approval-decision_human-1",
      request_id: outcome.approval_request_id,
      decision: "approve",
      object_digest: outcome.approval_object_digest,
      actor: "human:approver",
    };
    decisions.put(decision);
    const applied = await coordinator.advance({
      command: "apply_approval_decision",
      session_id: session.session_id,
      expected_session_digest: outcome.session.record_digest,
      request_id: decision.request_id,
      decision_id: decision.decision_id,
    });
    expect(applied.status).toBe("accepted");
  });

  it("rejects a brief whose claims cite foreign sources and never presents it", async () => {
    const root = makeRoot();
    const { session, handlers } = makeBriefPipeline(root, {
      briefHandler: (input) => ({
        status: "completed",
        output: {
          ...briefOutputFor(input),
          changes: [
            {
              summary: "无引用断言。",
              source_refs: [
                { locator: "capture://prd-proposal/foreign", source_digest: "f".repeat(64) },
              ],
            },
          ],
        },
      }),
    });
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.message).toMatch(/cited locator/iu);
    expect(readApprovalBriefRecord(root, session.session_id)).toBeUndefined();
  });

  it("enters the typed blocker when the required provider binding is missing, and resumes after configuration", async () => {
    const root = makeRoot();
    const session = makeSession();
    // Note: no Capture-scope binding committed for approval_brief.
    const briefAdapter = createInMemoryGroundedSynthesisAdapter((input) => ({
      status: "completed" as const,
      output: briefOutputFor(input as ApprovalBriefInput),
    }));
    const pipeline = makeReviewPipelineHandlers(root, { proposalDrafts: [makeValidDraft] });
    const risk = createCaptureRiskStageHandlers({
      projectRoot: root,
      policy: MATERIAL_POLICY,
      policy_digest: POLICY_DIGEST,
    });
    const brief = createCaptureApprovalBriefStageHandler({ projectRoot: root, port: briefAdapter });
    const accept = createCaptureAcceptanceStageHandler({
      projectRoot: root,
      readBaseline: () => BASELINE,
      policy_digest: POLICY_DIGEST,
      now: () => "2026-08-19T12:00:00.000Z",
    });
    const handlers = {
      ...pipeline.handlers,
      assessRisk: risk.assessRisk,
      approvalBrief: brief,
      accept,
    };
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("expected blocked");
    expect(outcome.blocker.reason).toBe("approval_brief_provider_required");
    expect(briefAdapter.invocations).toHaveLength(0);

    // The operator commits the required binding, then resumes.
    commitBriefBinding(root, session);
    const resumed = await coordinator.advance({
      command: "resume_capture",
      session_id: session.session_id,
    });
    expect(resumed.status).toBe("awaiting_approval");
    expect(briefAdapter.invocations).toHaveLength(1);
  });

  it("exhausts controlled retries on an unavailable provider and blocks typed", async () => {
    const root = makeRoot();
    const { session, handlers, briefAdapter } = makeBriefPipeline(root, {
      maxRetries: 1,
      briefHandler: () => ({
        status: "failed" as const,
        failure: {
          code: "provider_unavailable" as const,
          summary: "provider offline",
          retryable: true,
        },
      }),
    });
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("expected blocked");
    expect(outcome.blocker.reason).toBe("approval_brief_provider_required");
    // maxRetries=1 → exactly two attempts, no more.
    expect(briefAdapter.invocations).toHaveLength(2);
  });

  it("the preview rejects a tampered brief and keeps deterministic facts", async () => {
    const root = makeRoot();
    const { session, handlers } = makeBriefPipeline(root);
    const coordinator = createPrdCaptureCoordinator({ projectRoot: root, handlers });
    const outcome = await coordinator.advance(startCommandFor(session));
    expect(outcome.status).toBe("awaiting_approval");

    const proposal = readPrdProposalRevisions(root, session.session_id).at(-1)!;
    const risk = readCaptureRiskAssessments(root, session.session_id).at(-1)!;
    const record = readApprovalBriefRecord(root, session.session_id)!;
    const bundle = readApprovalBriefBundle(root, session.session_id)!;
    const facts = {
      proposal,
      validation_report: readPrdValidationReports(root, session.session_id).at(-1)!,
      review_report: readPrdReviewReports(root, session.session_id).at(-1)!,
      risk_assessment: risk,
      bundle,
    };

    // A brief bound to a different bundle cannot attach.
    const tampered = {
      ...record,
      output: { ...(record.output as ApprovalBriefOutput), bundle_digest: "f".repeat(64) },
    };
    const preview = buildCaptureApprovalPreview({ ...facts, brief: tampered });
    expect(preview.brief_status).toBe("rejected");
    expect(preview.object.proposal_content_digest).toBe(proposal.content_digest);
    expect(preview.risk.level).toBe(risk.level);
    expect(preview.scope.material).toBe(false);

    // The brief output schema carries no approval verdict or recommendation.
    const briefOutput = record.output as ApprovalBriefOutput;
    const withVerdict: Record<string, unknown> = {
      ...briefOutput,
      recommendation: "auto_approve",
    };
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("approval-brief-output", withVerdict).valid).toBe(
      false,
    );
  });
});
