import { writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProjectManifest,
  resolveHarnessPath,
  serializeProjectManifest,
  sha256Hex,
  harnessRootFor,
  LedgerRepository,
} from "@universal-harness-internal/core";

import {
  ApprovalService,
  WorkflowEngine,
  approvalDecisionArtifact,
  approvalDecisionArtifactPath,
  readApprovalSummary,
  resumeWorkflowOperation,
  ApprovalSummaryError,
  type ApprovalDependencies,
  type ApprovalIdKind,
  type RequestApprovalInput,
} from "../../src/index.js";
import {
  BASELINE,
  FIXED_NOW,
  cleanupDirectories,
  makeDeps,
  makeProjectRoot,
  makeStartInput,
  phaseIds,
} from "../workflow/helpers.js";

afterEach(() => {
  cleanupDirectories();
});

const OBJECT_DIGEST = "a".repeat(64);

function tickingClock(): () => string {
  let tick = 0;
  return () => {
    const timestamp = new Date(Date.parse(FIXED_NOW) + tick * 1000).toISOString();
    tick += 1;
    return timestamp;
  };
}

function makeApprovalDeps(
  projectRoot: string,
  tag: string,
  now: () => string,
  overrides?: Partial<ApprovalDependencies>,
): ApprovalDependencies {
  return {
    projectRoot,
    readBaseline: () => BASELINE,
    now,
    newId: phaseIds(tag) as (kind: ApprovalIdKind) => string,
    ...overrides,
  };
}

async function setup(tag: string): Promise<{
  projectRoot: string;
  service: ApprovalService;
  workflowOperationId: string;
  now: () => string;
}> {
  const projectRoot = makeProjectRoot();
  const now = tickingClock();
  const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds(`op${tag}`), now }));
  const started = await engine.startOperation(makeStartInput());
  const workflowOperationId = started.operation.workflow_operation_id;
  await engine.advance(workflowOperationId, "awaiting_approval");
  const service = new ApprovalService(makeApprovalDeps(projectRoot, `ap${tag}`, now));
  return { projectRoot, service, workflowOperationId, now };
}

function makeRequestInput(
  workflowOperationId: string,
  overrides?: Partial<RequestApprovalInput>,
): RequestApprovalInput {
  return {
    workflowOperationId,
    objectId: "requirement_baseline",
    objectType: "RequirementBaseline",
    objectDigest: OBJECT_DIGEST,
    baselineDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    impactPath: ["intent_t01", "requirement_t01"],
    risk: "medium",
    reason: "approve the requirement baseline",
    resumePhase: "capture",
    proposedBy: "agent:harness",
    ...overrides,
  };
}

async function resume(
  projectRoot: string,
  tag: string,
  workflowOperationId: string,
  now: () => string,
): Promise<void> {
  await resumeWorkflowOperation(
    makeDeps(projectRoot, { newId: phaseIds(`re${tag}`), now }),
    workflowOperationId,
  );
}

describe("readApprovalSummary", () => {
  it("summarizes a committed decision with a stable redacted actor_display", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("sum");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "sum", workflowOperationId, now);
    const record = await service.resolveDecision({
      requestId: outcome.request_id,
      decision: "approve",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });
    const decisionDigest = sha256Hex(approvalDecisionArtifact(record).content);

    const read = readApprovalSummary(projectRoot, decisionDigest);

    expect(read.summary).toEqual({
      request_id: outcome.request_id,
      approval_id: record.approval_id,
      decision: "approve",
      actor_display: read.summary.actor_display,
      decided_at: record.decided_at,
      decision_digest: decisionDigest,
    });
    expect(read.summary.actor_display).toMatch(/^审批者[0-9a-f]{12}$/u);
    // The raw actor never enters the shared display view (spec §10).
    expect(JSON.stringify(read)).not.toContain("user:bob");
    // Stable across reads; the CLI and the Dashboard share this function.
    expect(readApprovalSummary(projectRoot, decisionDigest).summary).toEqual(read.summary);

    const { operations } = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
    }).replay();
    const committing = operations.find((operation) =>
      operation.manifest.artifact_digests.includes(decisionDigest),
    );
    expect(read.provenance).toEqual({
      ledger_operation_id: committing?.manifest.ledger_operation_id,
      workflow_operation_id: workflowOperationId,
      artifact_path: approvalDecisionArtifactPath(record.approval_id),
      committed_at: committing?.manifest.committed_at,
    });
  });

  it("scopes actor_display to the project identity and never to the raw actor", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("scope");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "scope", workflowOperationId, now);
    const record = await service.resolveDecision({
      requestId: outcome.request_id,
      decision: "approve",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });
    const decisionDigest = sha256Hex(approvalDecisionArtifact(record).content);
    const unmanaged = readApprovalSummary(projectRoot, decisionDigest).summary.actor_display;

    const harnessRoot = harnessRootFor(projectRoot);
    writeFileSync(
      resolveHarnessPath(harnessRoot, "manifest.yaml"),
      serializeProjectManifest(
        createProjectManifest({ name: "demo-one", repositoryId: "repo-one" }),
      ),
    );
    const scoped = readApprovalSummary(projectRoot, decisionDigest).summary.actor_display;
    expect(scoped).toMatch(/^审批者[0-9a-f]{12}$/u);
    expect(scoped).not.toBe(unmanaged);

    writeFileSync(
      resolveHarnessPath(harnessRoot, "manifest.yaml"),
      serializeProjectManifest(
        createProjectManifest({ name: "demo-two", repositoryId: "repo-two" }),
      ),
    );
    const rescoped = readApprovalSummary(projectRoot, decisionDigest).summary.actor_display;
    expect(rescoped).not.toBe(scoped);
  });

  it("reports a defer decision truthfully as still pending", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("def");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "def", workflowOperationId, now);
    const record = await service.resolveDecision({
      requestId: outcome.request_id,
      decision: "defer",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });
    const decisionDigest = sha256Hex(approvalDecisionArtifact(record).content);

    const read = readApprovalSummary(projectRoot, decisionDigest);
    expect(read.summary.decision).toBe("defer");
    expect(read.summary.decided_at).toBe(record.decided_at);
    // A defer leaves the request pending; the summary never infers resolution.
    expect(service.pendingRequests(workflowOperationId)).toHaveLength(1);
  });

  it("keeps the remote decided_at of a materialized remote decision", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("rem");
    const outcome = await service.requestApproval(
      makeRequestInput(workflowOperationId, {
        requesterPrincipal: {
          principal_id: "principal_alice",
          principal_snapshot_digest: "f".repeat(64),
        },
      }),
    );
    await resume(projectRoot, "rem", workflowOperationId, now);
    const resolution = await service.resolveRemoteDecision({
      requestId: outcome.request_id,
      decision: "approve",
      objectDigest: OBJECT_DIGEST,
      actor: "principal_bob",
      decidedAt: "2026-08-29T00:00:00.000Z",
      remoteDecisionId: "remote-decision_r01",
      remoteDecisionDigest: "e".repeat(64),
    });
    const decisionDigest = sha256Hex(approvalDecisionArtifact(resolution.decision).content);

    const read = readApprovalSummary(projectRoot, decisionDigest);
    expect(read.summary.decision).toBe("approve");
    expect(read.summary.decided_at).toBe("2026-08-29T00:00:00.000Z");
    expect(JSON.stringify(read)).not.toContain("principal_bob");
  });

  it("rejects an unknown digest with a typed not-found instead of inferring success", async () => {
    const { projectRoot } = await setup("nf");
    let caught: unknown;
    try {
      readApprovalSummary(projectRoot, "0".repeat(64));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApprovalSummaryError);
    expect((caught as ApprovalSummaryError).kind).toBe("approval_decision_not_found");
  });

  it("fails closed when the committed decision bytes were replaced", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("tamp");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "tamp", workflowOperationId, now);
    const record = await service.resolveDecision({
      requestId: outcome.request_id,
      decision: "approve",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });
    const decisionDigest = sha256Hex(approvalDecisionArtifact(record).content);
    writeFileSync(
      resolveHarnessPath(
        harnessRootFor(projectRoot),
        approvalDecisionArtifactPath(record.approval_id),
      ),
      `${JSON.stringify({ tampered: true })}\n`,
    );

    let caught: unknown;
    try {
      readApprovalSummary(projectRoot, decisionDigest);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApprovalSummaryError);
    expect((caught as ApprovalSummaryError).kind).toBe("approval_decision_corrupt");
  });
});
