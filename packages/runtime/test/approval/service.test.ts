import { afterEach, describe, expect, it } from "vitest";

import { LedgerRepository, sha256Hex } from "@universal-harness-internal/core";

import {
  ApprovalService,
  WorkflowEngine,
  approvalDecisionArtifact,
  remoteDecisionDigestOf,
  resumeWorkflowOperation,
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

/**
 * Monotonic clock shared by every deps instance of one test: checkpoints sort
 * by timestamp first, and a fixed clock would make cross-component ordering
 * depend on id-string tie-breaks. Each new clock restarts at FIXED_NOW, so a
 * retried attempt reproduces byte-identical content.
 */
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

describe("ApprovalService.requestApproval", () => {
  it("persists the request and checkpoint in one ledger operation before awaiting input", async () => {
    const { projectRoot, engine, service, workflowOperationId } = await setup("a");

    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));

    expect(outcome.status).toBe("approval_required");
    expect(outcome.error_category).toBe("approval_required");
    expect(outcome.object_digest).toBe(OBJECT_DIGEST);
    expect(outcome.resume_command).toBe(`harness resume ${workflowOperationId}`);

    const replay = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).replay();
    const required = replay.events.find((event) => event.event_type === "ApprovalRequired");
    const checkpointed = replay.events
      .filter((event) => event.event_type === "CheckpointCommitted")
      .find((event) => event.ledger_operation_id === required?.ledger_operation_id);
    expect(required?.payload.request_id).toBe(outcome.request_id);
    expect(checkpointed, "request and checkpoint share one ledger operation").toBeDefined();
    const manifest = replay.operations.find(
      (operation) => operation.manifest.ledger_operation_id === required?.ledger_operation_id,
    );
    // request artifact + checkpoint record + working state document
    expect(manifest?.manifest.artifact_digests.length).toBeGreaterThanOrEqual(3);

    expect(service.getRequest(workflowOperationId, outcome.request_id)?.object_digest).toBe(
      OBJECT_DIGEST,
    );
    expect(engine.getOperation(workflowOperationId)?.state).toBe("blocked");
    expect(engine.getOperation(workflowOperationId)?.resume_state).toBe("awaiting_approval");
  });

  it("is idempotent when an interrupted commit is retried with the same ids", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(
      makeDeps(projectRoot, { newId: phaseIds("opb"), now: tickingClock() }),
    );
    const started = await engine.startOperation(makeStartInput());
    const workflowOperationId = started.operation.workflow_operation_id;
    await engine.advance(workflowOperationId, "awaiting_approval");

    // Each attempt gets a fresh mint and a fresh clock starting at FIXED_NOW,
    // so the retry reproduces byte-identical content for the ledger to
    // recognize as the same operation.
    const crashing = new ApprovalService(
      makeApprovalDeps(projectRoot, "apb", tickingClock(), {
        hooks: {
          atBoundary: (boundary) => {
            if (boundary === "staging.prepared") throw new Error("simulated crash");
          },
        },
      }),
    );
    await expect(crashing.requestApproval(makeRequestInput(workflowOperationId))).rejects.toThrow(
      "simulated crash",
    );
    expect(crashing.pendingRequests(workflowOperationId)).toEqual([]);

    const recovered = new ApprovalService(makeApprovalDeps(projectRoot, "apb", tickingClock()));
    const outcome = await recovered.requestApproval(makeRequestInput(workflowOperationId));
    expect(outcome.status).toBe("approval_required");
    expect(recovered.pendingRequests(workflowOperationId).map((r) => r.request_id)).toEqual([
      outcome.request_id,
    ]);

    const replay = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).replay();
    // start + advance + request/checkpoint + block: the crash added nothing.
    expect(replay.operations).toHaveLength(4);
  });
});

describe("ApprovalService.resolveDecision", () => {
  it("commits an explicit approve for one exact request/object/digest", async () => {
    const { projectRoot, engine, service, workflowOperationId, now } = await setup("c");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "c", workflowOperationId, now);

    const decision = await service.resolveDecision({
      requestId: outcome.request_id,
      decision: "approve",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });

    expect(decision.decision).toBe("approve");
    expect(decision.request_id).toBe(outcome.request_id);
    expect(service.pendingRequests(workflowOperationId)).toEqual([]);

    const artifact = approvalDecisionArtifact(decision);
    const workingState = engine.getWorkingState(workflowOperationId);
    expect(workingState?.approval_digests).toHaveLength(1);
    expect(workingState?.approval_digests).toEqual([sha256Hex(artifact.content)]);
    expect(workingState?.blockers).not.toContain(
      `approval request ${outcome.request_id} awaiting a decision`,
    );

    await expect(
      service.resolveDecision({
        requestId: outcome.request_id,
        decision: "approve",
        objectDigest: OBJECT_DIGEST,
        actor: "user:bob",
      }),
    ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_not_pending" });
  });

  it("reject closes the proposal while keeping the audit history", async () => {
    const { projectRoot, engine, service, workflowOperationId, now } = await setup("d");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "d", workflowOperationId, now);

    await service.resolveDecision({
      requestId: outcome.request_id,
      decision: "reject",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });

    expect(service.pendingRequests(workflowOperationId)).toEqual([]);
    expect(service.getRequest(workflowOperationId, outcome.request_id)).toBeDefined();
    expect(engine.getWorkingState(workflowOperationId)?.blockers).not.toContain(
      `approval request ${outcome.request_id} awaiting a decision`,
    );
  });

  it("defer keeps the request pending and resumable", async () => {
    const { projectRoot, engine, service, workflowOperationId, now } = await setup("e");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "e", workflowOperationId, now);

    await service.resolveDecision({
      requestId: outcome.request_id,
      decision: "defer",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });

    expect(service.pendingRequests(workflowOperationId).map((r) => r.request_id)).toEqual([
      outcome.request_id,
    ]);
    expect(engine.getWorkingState(workflowOperationId)?.blockers).toContain(
      `approval request ${outcome.request_id} awaiting a decision`,
    );
  });

  it("never lets the proposing actor resolve its own request", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("f");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "f", workflowOperationId, now);

    await expect(
      service.resolveDecision({
        requestId: outcome.request_id,
        decision: "approve",
        objectDigest: OBJECT_DIGEST,
        actor: "agent:harness",
      }),
    ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_self_approval" });
    expect(service.pendingRequests(workflowOperationId)).toHaveLength(1);
  });

  it("refuses a decision binding a different object digest", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("g");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "g", workflowOperationId, now);

    await expect(
      service.resolveDecision({
        requestId: outcome.request_id,
        decision: "approve",
        objectDigest: "9".repeat(64),
        actor: "user:bob",
      }),
    ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_binding_mismatch" });
  });

  it("refuses decisions the request does not allow; there is no implicit default", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("h");
    const outcome = await service.requestApproval(
      makeRequestInput(workflowOperationId, { allowedDecisions: ["approve", "defer"] }),
    );
    await resume(projectRoot, "h", workflowOperationId, now);

    await expect(
      service.resolveDecision({
        requestId: outcome.request_id,
        decision: "reject",
        objectDigest: OBJECT_DIGEST,
        actor: "user:bob",
      }),
    ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_decision_not_allowed" });
  });

  it("processes multiple requests one at a time in deterministic order", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("i");
    const first = await service.requestApproval(
      makeRequestInput(workflowOperationId, { objectId: "baseline_one" }),
    );
    await resume(projectRoot, "i1", workflowOperationId, now);
    const second = await service.requestApproval(
      makeRequestInput(workflowOperationId, { objectId: "baseline_two" }),
    );
    await resume(projectRoot, "i2", workflowOperationId, now);

    expect(service.nextPendingRequest(workflowOperationId)?.request_id).toBe(first.request_id);

    await service.resolveDecision({
      requestId: first.request_id,
      decision: "approve",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });
    expect(service.nextPendingRequest(workflowOperationId)?.request_id).toBe(second.request_id);

    await service.resolveDecision({
      requestId: second.request_id,
      decision: "reject",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });
    expect(service.nextPendingRequest(workflowOperationId)).toBeUndefined();
  });
});

describe("ApprovalService binding revalidation", () => {
  it("invalidates a drifted request, re-issues it and refuses the stale decision", async () => {
    const projectRoot = makeProjectRoot();
    const now = tickingClock();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("opj"), now }));
    const started = await engine.startOperation(makeStartInput());
    const workflowOperationId = started.operation.workflow_operation_id;
    await engine.advance(workflowOperationId, "awaiting_approval");

    let policyDigest = "c".repeat(64);
    const service = new ApprovalService(
      makeApprovalDeps(projectRoot, "apj", now, {
        readBinding: (request) => ({
          objectDigest: request.object_digest,
          baselineDigest: request.baseline_digest,
          policyDigest,
          impactPath: [...request.impact_path],
        }),
      }),
    );
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "j", workflowOperationId, now);

    policyDigest = "d".repeat(64);
    const failure = await service
      .resolveDecision({
        requestId: outcome.request_id,
        decision: "approve",
        objectDigest: OBJECT_DIGEST,
        actor: "user:bob",
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "ApprovalError", kind: "approval_binding_drift" });
    const newRequestId = (failure as { data?: { new_request_id?: string } }).data?.new_request_id;
    expect(newRequestId).toBeDefined();

    const pending = service.pendingRequests(workflowOperationId);
    expect(pending.map((request) => request.request_id)).toEqual([newRequestId]);
    expect(pending[0]?.policy_digest).toBe("d".repeat(64));

    const replay = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).replay();
    const invalidation = replay.events.find(
      (event) =>
        event.event_type === "ApprovalRequired" &&
        event.payload.invalidated_request_id === outcome.request_id,
    );
    expect(invalidation?.payload.changed).toEqual(["policy_digest"]);

    // The re-issued request can be decided; the stale one stays closed.
    await service.resolveDecision({
      requestId: newRequestId ?? "",
      decision: "approve",
      objectDigest: OBJECT_DIGEST,
      actor: "user:bob",
    });
    expect(service.pendingRequests(workflowOperationId)).toEqual([]);
  });
});

describe("ApprovalService.requestApprovalInteractively", () => {
  it("resolves an explicit approve straight from the prompt", async () => {
    const { service, workflowOperationId } = await setup("k");
    const outcome = await service.requestApprovalInteractively(
      makeRequestInput(workflowOperationId),
      { prompt: () => Promise.resolve("approve") },
      "user:bob",
    );

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") return;
    expect(outcome.decision.decision).toBe("approve");
    expect(outcome.decision.actor).toBe("user:bob");
    expect(service.pendingRequests(workflowOperationId)).toEqual([]);
  });

  it.each([
    ["EOF (null input)", () => Promise.resolve(null)],
    ["unparseable input", () => Promise.resolve("whatever")],
    ["Ctrl-C (prompter throws)", () => Promise.reject(new Error("SIGINT"))],
  ])("defers on %s and keeps the operation resumable", async (_label, prompt) => {
    const { engine, service, workflowOperationId } = await setup(`l${_label.length}`);
    const outcome = await service.requestApprovalInteractively(
      makeRequestInput(workflowOperationId),
      { prompt },
      "user:bob",
    );

    expect(outcome.status).toBe("deferred");
    if (outcome.status !== "deferred") return;
    expect(outcome.required.resume_command).toBe(`harness resume ${workflowOperationId}`);
    expect(engine.getOperation(workflowOperationId)?.state).toBe("blocked");
    expect(service.pendingRequests(workflowOperationId)).toHaveLength(1);
  });
});

describe("ApprovalService.resolveRemoteDecision", () => {
  const REMOTE_DECISION_DIGEST = "e".repeat(64);
  const REMOTE_DECIDED_AT = "2026-08-29T00:00:00.000Z";
  const requesterPrincipal = {
    principal_id: "principal_alice",
    principal_snapshot_digest: "f".repeat(64),
  };

  function remoteInput(requestId: string, overrides?: Record<string, unknown>) {
    return {
      requestId,
      decision: "approve" as const,
      objectDigest: OBJECT_DIGEST,
      actor: "principal_bob",
      decidedAt: REMOTE_DECIDED_AT,
      remoteDecisionId: "remote-decision_r01",
      remoteDecisionDigest: REMOTE_DECISION_DIGEST,
      ...overrides,
    };
  }

  it("materializes a remote approve into a protocol 1.2 decision bound to the remote digest", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("ra");
    const outcome = await service.requestApproval(
      makeRequestInput(workflowOperationId, { requesterPrincipal }),
    );
    await resume(projectRoot, "ra", workflowOperationId, now);

    const resolution = await service.resolveRemoteDecision(remoteInput(outcome.request_id));

    expect(resolution.replayed).toBe(false);
    expect(resolution.decision).toMatchObject({
      protocol_version: "1.2.0",
      record_kind: "approval_decision",
      request_id: outcome.request_id,
      actor: "principal_bob",
      decision: "approve",
      object_digest: OBJECT_DIGEST,
      decided_at: REMOTE_DECIDED_AT,
    });
    expect(remoteDecisionDigestOf(resolution.decision)).toBe(REMOTE_DECISION_DIGEST);
    expect(service.pendingRequests(workflowOperationId)).toEqual([]);

    // The materialization event lands in the same ledger commit as the
    // decision, at protocol 1.2, binding exactly the remote decision.
    const replay = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).replay();
    const materialized = replay.events.find(
      (event) => event.event_type === "RemoteApprovalMaterialized",
    );
    expect(materialized).toMatchObject({
      protocol_version: "1.2.0",
      payload: {
        request_id: outcome.request_id,
        approval_id: resolution.decision.approval_id,
        remote_decision_id: "remote-decision_r01",
        remote_decision_digest: REMOTE_DECISION_DIGEST,
        principal_id: "principal_bob",
      },
    });
  });

  it("replays an already materialized remote decision without a second commit", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("rb");
    const outcome = await service.requestApproval(
      makeRequestInput(workflowOperationId, { requesterPrincipal }),
    );
    await resume(projectRoot, "rb", workflowOperationId, now);

    const first = await service.resolveRemoteDecision(remoteInput(outcome.request_id));
    const second = await service.resolveRemoteDecision(remoteInput(outcome.request_id));

    expect(second.replayed).toBe(true);
    expect(second.decision.approval_id).toBe(first.decision.approval_id);
    const replay = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).replay();
    expect(
      replay.events.filter((event) => event.event_type === "RemoteApprovalMaterialized"),
    ).toHaveLength(1);
  });

  it("refuses a legacy request without requester principal binding; it must be re-issued", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("rc");
    const outcome = await service.requestApproval(makeRequestInput(workflowOperationId));
    await resume(projectRoot, "rc", workflowOperationId, now);

    await expect(
      service.resolveRemoteDecision(remoteInput(outcome.request_id)),
    ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_binding_mismatch" });
    expect(service.pendingRequests(workflowOperationId)).toHaveLength(1);
  });

  it("never lets the requester principal resolve its own request remotely", async () => {
    const { projectRoot, service, workflowOperationId, now } = await setup("rd");
    const outcome = await service.requestApproval(
      makeRequestInput(workflowOperationId, { requesterPrincipal }),
    );
    await resume(projectRoot, "rd", workflowOperationId, now);

    await expect(
      service.resolveRemoteDecision(remoteInput(outcome.request_id, { actor: "principal_alice" })),
    ).rejects.toMatchObject({ name: "ApprovalError", kind: "approval_self_approval" });
    expect(service.pendingRequests(workflowOperationId)).toHaveLength(1);
  });

  it("re-issues the request and refuses the decision when the bindings drifted", async () => {
    const projectRoot = makeProjectRoot();
    const now = tickingClock();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("opre"), now }));
    const started = await engine.startOperation(makeStartInput());
    const workflowOperationId = started.operation.workflow_operation_id;
    await engine.advance(workflowOperationId, "awaiting_approval");

    let policyDigest = "c".repeat(64);
    const service = new ApprovalService(
      makeApprovalDeps(projectRoot, "apre", now, {
        readBinding: (request) => ({
          objectDigest: request.object_digest,
          baselineDigest: request.baseline_digest,
          policyDigest,
          impactPath: [...request.impact_path],
        }),
      }),
    );
    const outcome = await service.requestApproval(
      makeRequestInput(workflowOperationId, { requesterPrincipal }),
    );
    await resume(projectRoot, "re", workflowOperationId, now);

    policyDigest = "d".repeat(64);
    const failure = await service
      .resolveRemoteDecision(remoteInput(outcome.request_id))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "ApprovalError", kind: "approval_binding_drift" });
    // The re-issued request carries the requester principal binding forward.
    const pending = service.pendingRequests(workflowOperationId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request_id).not.toBe(outcome.request_id);
    expect(pending[0]?.requester_principal_id).toBe("principal_alice");
    expect(pending[0]?.protocol_version).toBe("1.2.0");
  });
});
