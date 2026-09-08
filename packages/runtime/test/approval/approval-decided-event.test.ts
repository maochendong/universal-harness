import { afterEach, describe, expect, it } from "vitest";

import { LedgerRepository, sha256Hex } from "@universal-harness-internal/core";

import {
  ApprovalService,
  WorkflowEngine,
  approvalDecisionArtifact,
  resumeWorkflowOperation,
  type ApprovalDecision,
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
  engine: WorkflowEngine;
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
  return { projectRoot, engine, service, workflowOperationId, now };
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

function replay(projectRoot: string) {
  return new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).replay();
}

describe("ApprovalDecided event (local decisions)", () => {
  it.each(["approve", "reject", "defer"] as const)(
    "commits exactly one ApprovalDecided event in the decision's own ledger operation (%s)",
    async (decision: ApprovalDecision) => {
      const { projectRoot, service, workflowOperationId, now } = await setup(`d${decision}`);
      const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
      await resume(projectRoot, `d${decision}`, workflowOperationId, now);

      const record = await service.resolveDecision({
        requestId: outcome.request_id,
        decision,
        objectDigest: OBJECT_DIGEST,
        actor: "user:bob",
      });

      const decisionDigest = sha256Hex(approvalDecisionArtifact(record).content);
      const { operations, events } = replay(projectRoot);
      const committing = operations.find((operation) =>
        operation.manifest.artifact_digests.includes(decisionDigest),
      );
      expect(committing).toBeDefined();
      // The 1.4 event pins the whole transaction even though the local
      // decision record itself stays at protocol 1.0.
      expect(committing?.manifest.required_reader_version).toBe("1.4.0");

      const decided = events.filter((event) => event.event_type === "ApprovalDecided");
      expect(decided).toHaveLength(1);
      expect(decided[0]?.ledger_operation_id).toBe(committing?.manifest.ledger_operation_id);
      expect(decided[0]).toMatchObject({
        protocol_version: "1.4.0",
        payload: {
          request_id: outcome.request_id,
          approval_id: record.approval_id,
          decision,
          object_digest: OBJECT_DIGEST,
          decision_digest: decisionDigest,
          decided_at: record.decided_at,
        },
      });
      // No raw actor on the event payload.
      expect(Object.keys(decided[0]?.payload ?? {})).toHaveLength(6);
    },
  );

  it("leaves one ApprovalDecided event per decision across defer -> defer -> approve", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("dda");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "dda", workflowOperationId, now);

    for (const decision of ["defer", "defer", "approve"] as const) {
      await service.resolveDecision({
        requestId: outcome.request_id,
        decision,
        objectDigest: OBJECT_DIGEST,
        actor: "user:bob",
      });
    }

    const { events } = replay(projectRoot);
    const decided = events.filter((event) => event.event_type === "ApprovalDecided");
    expect(decided).toHaveLength(3);
    expect(decided.map((event) => event.payload["decision"])).toEqual([
      "defer",
      "defer",
      "approve",
    ]);
    expect(new Set(decided.map((event) => event.payload["approval_id"])).size).toBe(3);
    expect(service.pendingRequests(workflowOperationId)).toEqual([]);
  });

  it("commits no ApprovalDecided event for refused decisions", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("ref");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "ref", workflowOperationId, now);

    await expect(
      service.resolveDecision({
        requestId: outcome.request_id,
        decision: "approve",
        objectDigest: OBJECT_DIGEST,
        actor: "agent:harness",
      }),
    ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_self_approval" });
    await expect(
      service.resolveDecision({
        requestId: outcome.request_id,
        decision: "approve",
        objectDigest: "9".repeat(64),
        actor: "user:bob",
      }),
    ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_binding_mismatch" });

    const { events } = replay(projectRoot);
    expect(events.filter((event) => event.event_type === "ApprovalDecided")).toHaveLength(0);
  });

  it("commits no ApprovalDecided event when binding drift re-issues the request", async () => {
    const { projectRoot, workflowOperationId, now } = await setup("drift");
    let policyDigest = "c".repeat(64);
    const service = new ApprovalService(
      makeApprovalDeps(projectRoot, "apdrift", now, {
        readBinding: (request) => ({
          objectDigest: request.object_digest,
          baselineDigest: request.baseline_digest,
          policyDigest,
          impactPath: [...request.impact_path],
        }),
      }),
    );
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "drift", workflowOperationId, now);

    policyDigest = "d".repeat(64);
    await expect(
      service.resolveDecision({
        requestId: outcome.request_id,
        decision: "approve",
        objectDigest: OBJECT_DIGEST,
        actor: "user:bob",
      }),
    ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_binding_drift" });

    const { events } = replay(projectRoot);
    expect(events.filter((event) => event.event_type === "ApprovalDecided")).toHaveLength(0);
  });

  it("leaves no committed ApprovalDecided event when the decision commit crashes", async () => {
    const { projectRoot, workflowOperationId, now } = await setup("crash");
    const service = new ApprovalService(makeApprovalDeps(projectRoot, "apcrash", now));
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "crash", workflowOperationId, now);

    const crashing = new ApprovalService(
      makeApprovalDeps(projectRoot, "apcrash2", now, {
        hooks: {
          atBoundary: (boundary) => {
            if (boundary === "staging.prepared") throw new Error("simulated crash");
          },
        },
      }),
    );
    await expect(
      crashing.resolveDecision({
        requestId: outcome.request_id,
        decision: "approve",
        objectDigest: OBJECT_DIGEST,
        actor: "user:bob",
      }),
    ).rejects.toThrow(/simulated crash|ledger_failure/);

    const { events } = replay(projectRoot);
    expect(events.filter((event) => event.event_type === "ApprovalDecided")).toHaveLength(0);
    expect(service.pendingRequests(workflowOperationId)).toHaveLength(1);
  });
});

describe("ApprovalDecided event (remote materialization)", () => {
  const REMOTE_DECISION_DIGEST = "e".repeat(64);
  const REMOTE_DECIDED_AT = "2026-08-29T00:00:00.000Z";
  const requesterPrincipal = {
    principal_id: "principal_alice",
    principal_snapshot_digest: "f".repeat(64),
  };

  function remoteInput(requestId: string) {
    return {
      requestId,
      decision: "approve" as const,
      objectDigest: OBJECT_DIGEST,
      actor: "principal_bob",
      decidedAt: REMOTE_DECIDED_AT,
      remoteDecisionId: "remote-decision_r01",
      remoteDecisionDigest: REMOTE_DECISION_DIGEST,
    };
  }

  it("commits ApprovalDecided beside RemoteApprovalMaterialized in one pinned 1.4 operation", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("rad");
    const outcome = await service.requestApproval(
      makeRequestInput(workflowOperationId, { requesterPrincipal }),
    );
    await resume(projectRoot, "rad", workflowOperationId, now);

    const resolution = await service.resolveRemoteDecision(remoteInput(outcome.request_id));
    expect(resolution.replayed).toBe(false);

    const decisionDigest = sha256Hex(approvalDecisionArtifact(resolution.decision).content);
    const { operations, events } = replay(projectRoot);
    const committing = operations.find((operation) =>
      operation.manifest.artifact_digests.includes(decisionDigest),
    );
    // The transaction mixes the 1.2 RemoteApprovalMaterialized event, the 1.2
    // decision record and the 1.4 ApprovalDecided event; the pin is the max.
    expect(committing?.manifest.required_reader_version).toBe("1.4.0");

    const operationEvents = events.filter(
      (event) => event.ledger_operation_id === committing?.manifest.ledger_operation_id,
    );
    const materialized = operationEvents.filter(
      (event) => event.event_type === "RemoteApprovalMaterialized",
    );
    const decided = operationEvents.filter((event) => event.event_type === "ApprovalDecided");
    expect(materialized).toHaveLength(1);
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      protocol_version: "1.4.0",
      payload: {
        request_id: outcome.request_id,
        approval_id: resolution.decision.approval_id,
        decision: "approve",
        object_digest: OBJECT_DIGEST,
        decision_digest: decisionDigest,
        // The materialized event keeps the remote decision's own timestamp.
        decided_at: REMOTE_DECIDED_AT,
      },
    });
  });

  it("adds no events when an idempotent retry replays the materialized decision", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("rreplay");
    const outcome = await service.requestApproval(
      makeRequestInput(workflowOperationId, { requesterPrincipal }),
    );
    await resume(projectRoot, "rreplay", workflowOperationId, now);

    await service.resolveRemoteDecision(remoteInput(outcome.request_id));
    const second = await service.resolveRemoteDecision(remoteInput(outcome.request_id));
    expect(second.replayed).toBe(true);

    const { events } = replay(projectRoot);
    expect(events.filter((event) => event.event_type === "ApprovalDecided")).toHaveLength(1);
    expect(
      events.filter((event) => event.event_type === "RemoteApprovalMaterialized"),
    ).toHaveLength(1);
  });
});
