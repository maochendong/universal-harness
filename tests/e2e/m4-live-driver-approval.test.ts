import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  sha256Hex,
  verifyRecordEnvelope,
} from "../../packages/core/src/index.js";
import type {
  AgentAdapter,
  AgentProviderManifest,
  AgentRunResult,
  AgentTaskEnvelope,
} from "../../packages/plugin-sdk/src/index.js";
import {
  ApprovalService,
  createDefaultGateSuite,
  createProjectSchedulerHost,
  readApprovalDecisions,
  type ProjectSchedulerHost,
} from "../../packages/runtime/src/index.js";
import { readApprovalRequests } from "../../packages/runtime/src/approval/request.js";
import { actionDigest } from "../../packages/runtime/src/policy/action.js";
import { buildDecision } from "../../packages/runtime/src/policy/decision.js";
import { mergePolicyLayers } from "../../packages/runtime/src/policy/evaluator.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
} from "../../packages/runtime/test/bootstrap/helpers.js";

import {
  createLedgerSchedulerAuthority,
  createM4E2eFixture,
  type M4E2eFixture,
} from "./m4-scheduler-fixture.js";

/**
 * M4 AC-17 readiness evidence (design §10.2/§15.2, plan Task 11/12): over the
 * real-Git M4 e2e fixture, prove that
 *
 * (a) while the driver stays alive, a dispatch paused by Policy
 *     `requires_approval` continues after the digest-bound Approval is
 *     committed — the same ProjectSchedulerHost drives the operation to
 *     completion with no host restart and no explicit workflow resume, and
 *     every granted Lease carries the exact approval digest that satisfied it;
 * (b) operation-level cancellation is durable: a cooperative cancel commits
 *     terminal `user_cancellation` Runs and digest-chained `revoked` Leases
 *     whose cancel command ids and policy bindings recompute exactly, and a
 *     brand-new host over the same Ledger (the crash/recovery equivalent)
 *     reports `cancelled` without dispatching anything again.
 *
 * Everything below runs the production scheduler/approval stack; only the
 * external Agent boundary and the policy rule are deterministic fixtures.
 *
 * Note (review P2): the Lease approval-digest closure asserted in (a) depends
 * on the in-memory resolver echoing `requires_approval` + `approval_digest`,
 * the shape grantTaskLease records. The production evaluator answers a
 * satisfied approval with `allow` + `approval_digest`, and grantTaskLease
 * records `approval_digests: []` on `allow` — a pre-existing runtime
 * divergence, not introduced here and not weakening the wake-up proof, but
 * recorded as a to-clarify item.
 */

const ITERATION_ID = "iteration_m4_release_e2e";

const MANIFEST: AgentProviderManifest = {
  provider: "deterministic-managed-ac17-fixture",
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
  resume_semantics: "explicit",
};

function sequentialIds(namespace: string): (kind: string) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${namespace}_${kind}_${String(next).padStart(3, "0")}`;
  };
}

function successResult(taskId: string): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: `ac17 fixture completed ${taskId}`,
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: {
      files_changed: 1,
      insertions: 1,
      deletions: 0,
      paths: [`src/${taskId}/outcome.ts`],
    },
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      duration_ms: 1,
      metering: "provider_reported",
    },
    budget_observations: [
      { dimension: "steps", availability: "measured", used: 1, limit: 10, enforcement: "harness" },
      {
        dimension: "tokens",
        availability: "measured",
        used: 15,
        limit: 1_000,
        enforcement: "harness",
      },
    ],
    evidence: [
      {
        kind: "adapter_trace",
        locator: `file:///ac17-agent-evidence/${taskId}.log`,
        digest: contentDigest({ taskId, evidence: "ac17-trace" }),
      },
    ],
    undeclared_writes: [],
  };
}

function cancelledResult(): AgentRunResult {
  return {
    ...successResult("cancelled"),
    outcome: "partial",
    termination_reason: "user_cancellation",
    completion_claimed: false,
    summary: "cancelled cooperatively",
    evidence: [],
  };
}

/** Deterministic adapter that writes its declared output and hands off. */
function writingAdapter(envelope: AgentTaskEnvelope, worktreeRoot: string): AgentRunResult {
  const scope = envelope.proposed_write_paths[0];
  if (scope === undefined) throw new Error("task has no declared write scope");
  const directory = join(worktreeRoot, scope);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "outcome.ts"),
    `export const task = ${JSON.stringify(envelope.task_id)};\n`,
    "utf8",
  );
  return successResult(envelope.task_id);
}

function createTestHost(
  fixture: M4E2eFixture,
  options: {
    readonly namespace: string;
    readonly requireDispatchApproval?: boolean;
    readonly run: (
      envelope: AgentTaskEnvelope,
      worktreeRoot: string,
      signal: AbortSignal | undefined,
    ) => Promise<AgentRunResult> | AgentRunResult;
  },
): ProjectSchedulerHost {
  return createProjectSchedulerHost({
    projectRoot: fixture.projectRoot,
    readBaseline: () => headOf(fixture.projectRoot),
    agentSlotFactory: {
      adapter_manifest_digest: contentDigest({ manifest: MANIFEST }),
      manifest: MANIFEST,
      create: ({ worktree_root }): AgentAdapter => ({
        name: "deterministic-managed-ac17-fixture",
        manifest: MANIFEST,
        run: (envelope, runOptions) =>
          Promise.resolve(options.run(envelope, worktree_root, runOptions.signal)),
      }),
    },
    adapterCapabilities: ["fs.read", "fs.write"],
    maxConcurrency: 2,
    policyResolver: (action) => {
      // Mirror the production four-state rule: a dispatch always requires
      // approval and is satisfied only by the exact approval digest the
      // committed decision carries (design §11).
      const requiresApproval =
        options.requireDispatchApproval === true && action.kind === "dispatch_task";
      return buildDecision({
        outcome: requiresApproval ? "requires_approval" : "allow",
        reasons: requiresApproval ? ["release policy requires approval"] : [],
        action_digest: actionDigest(action),
        effective: mergePolicyLayers([]).effective,
        ...(action.approval_digest === undefined
          ? {}
          : { approval_digest: action.approval_digest }),
      });
    },
    gateSuiteForWorkspace: (workspaceRoot) => createDefaultGateSuite(workspaceRoot),
    now: () => FIXED_NOW,
    newId: sequentialIds(options.namespace),
  });
}

function runInput(fixture: M4E2eFixture): {
  readonly operation_id: string;
  readonly iteration_id: string;
  readonly capability_plan_digest: string;
  readonly expected_plan_digest: string;
} {
  return {
    operation_id: fixture.operationId,
    iteration_id: ITERATION_ID,
    capability_plan_digest: fixture.capabilityPlan.record_digest,
    expected_plan_digest: fixture.planDigest,
  };
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("M4 AC-17 live-driver approval and durable cancellation", () => {
  it("wakes requires_approval dispatches on the live driver once the digest-bound approval lands", async () => {
    const fixture = await createM4E2eFixture({ profileId: "governed" });
    try {
      // One host instance is the live driver for the whole scenario.
      const host = createTestHost(fixture, {
        namespace: "ac17_approval",
        requireDispatchApproval: true,
        run: writingAdapter,
      });
      const drive = () =>
        host.parallelExecution.port.run({
          ...runInput(fixture),
          driver_lock: host.parallelExecution.driverLock(),
        });

      const first = await drive();
      expect(first.status).toBe("paused");

      // Both wave-0 dispatches paused on exactly one digest-bound request
      // each; nothing was leased or run before its approval landed.
      const approvals = new ApprovalService(fixture.deps);
      const initialPending = approvals.pendingRequests(fixture.operationId);
      expect(initialPending).toHaveLength(2);
      expect(initialPending.every((request) => request.object_type === "scheduler_action")).toBe(
        true,
      );
      const authority = createLedgerSchedulerAuthority({ deps: fixture.deps });
      const beforeApproval = await authority.readFacts(fixture.operationId);
      expect(beforeApproval.leases).toEqual([]);
      expect(beforeApproval.runs).toEqual([]);

      // Approve whatever is pending and re-drive with the same live driver:
      // each committed approval wakes exactly its bound dispatch until all
      // four tasks and three waves complete — no restart, no explicit resume.
      let outcome = first;
      const decided: Awaited<ReturnType<ApprovalService["resolveDecision"]>>[] = [];
      for (let round = 0; round < 8 && outcome.status === "paused"; round += 1) {
        const pending = approvals.pendingRequests(fixture.operationId);
        expect(pending.length).toBeGreaterThan(0);
        for (const request of pending) {
          decided.push(
            await approvals.resolveDecision({
              requestId: request.request_id,
              decision: "approve",
              objectDigest: request.object_digest,
              actor: "human:ac17-e2e",
            }),
          );
        }
        outcome = await drive();
      }
      expect(outcome.status).toBe("completed");
      // wave_integration_digests accumulate per drive; the authoritative
      // three-wave count is asserted on the Ledger facts below.
      expect(outcome.wave_integration_digests.length).toBeGreaterThanOrEqual(1);
      // Five decisions for four tasks: the first task_ui approval bound the
      // action with the full iteration budget; once the approved task_api
      // dispatch consumed budget, that exact action digest drifted and the
      // scheduler correctly re-issued the request instead of honoring the
      // stale approval (design §11 digest binding).
      expect(decided).toHaveLength(5);
      const uiRequests = readApprovalRequests(
        harnessRootFor(fixture.projectRoot),
        readCommittedOperations(harnessRootFor(fixture.projectRoot)),
        fixture.operationId,
      ).filter((request) => request.object_id === "task_ui");
      expect(uiRequests).toHaveLength(2);
      expect(new Set(uiRequests.map((request) => request.object_digest)).size).toBe(2);

      // Digest closure: every granted Lease carries exactly the digest of
      // the committed ApprovalDecisionRecord that satisfied its dispatch.
      const committedDecisions = readApprovalDecisions(
        harnessRootFor(fixture.projectRoot),
        readCommittedOperations(harnessRootFor(fixture.projectRoot)),
        fixture.operationId,
      );
      // Scheduler-minted requests carry content-derived ids; the fixture's
      // own plan-acceptance decision (setup_approval_request_001) stays out.
      const schedulerDecisions = committedDecisions.filter((decision) =>
        decision.request_id.startsWith("approval-request_"),
      );
      expect(schedulerDecisions).toHaveLength(5);
      const decisionDigests = new Set(
        schedulerDecisions.map((decision) => sha256Hex(`${canonicalizeJson(decision)}\n`)),
      );
      const afterCompletion = await authority.readFacts(fixture.operationId);
      const granted = afterCompletion.leases.filter((lease) => lease.state === "granted");
      expect(granted).toHaveLength(4);
      for (const lease of granted) {
        expect(lease.approval_digests).toHaveLength(1);
        expect(decisionDigests.has(lease.approval_digests[0] ?? "")).toBe(true);
        expect(verifyRecordEnvelope(lease)).toBe(true);
      }
      expect(afterCompletion.wave_integrations).toHaveLength(3);
    } finally {
      cleanupDirectories();
    }
  }, 120_000);

  it("persists operation cancellation as digest-chained records a fresh driver cannot undo", async () => {
    const fixture = await createM4E2eFixture({ profileId: "governed" });
    try {
      const started: string[] = [];
      const host = createTestHost(fixture, {
        namespace: "ac17_cancel",
        run: (envelope, worktreeRoot, signal) => {
          started.push(envelope.task_id);
          if (signal?.aborted === true) return cancelledResult();
          // Cooperative fixture: hold the slot until the abort lands, then
          // confirm termination with the user_cancellation accounting.
          return new Promise<AgentRunResult>((resolve) => {
            signal?.addEventListener("abort", () => resolve(cancelledResult()), {
              once: true,
            });
          });
        },
      });
      const running = host.parallelExecution.port.run({
        ...runInput(fixture),
        driver_lock: host.parallelExecution.driverLock(),
      });
      await waitFor(() => started.length === 2, "both wave-0 tasks to start");

      const reason = "e2e operator abort";
      const cancellation = await host.cancelOperation(fixture.operationId, reason);
      expect(cancellation.status).toBe("cancelled");
      await expect(running).resolves.toMatchObject({ status: "cancelled" });
      expect(
        cancellation.read_model.projection.tasks
          .filter((task) => task.status === "cancelled")
          .map((task) => task.task_id)
          .sort(),
      ).toEqual(["task_api", "task_ui"]);

      // Durable closure: terminal user_cancellation Runs plus revoked
      // Leases whose cancel command ids recompute exactly and whose digest
      // chain and policy binding still point at the authorizing decision.
      const authority = createLedgerSchedulerAuthority({ deps: fixture.deps });
      const facts = await authority.readFacts(fixture.operationId);
      const terminalRuns = facts.runs.filter((run) => run.record_kind === "run_terminated");
      expect(terminalRuns.map((run) => run.task_id).sort()).toEqual(["task_api", "task_ui"]);
      expect(terminalRuns.every((run) => run.termination_reason === "user_cancellation")).toBe(
        true,
      );
      const cancelCommandId = `command_${contentDigest({
        purpose: "cancel-operation",
        operation_id: fixture.operationId,
        reason,
      }).slice(0, 24)}`;
      for (const taskId of ["task_api", "task_ui"]) {
        const chain = facts.leases.filter((lease) => lease.task_id === taskId);
        const grantedLease = chain.find((lease) => lease.state === "granted");
        const revokedLease = chain.find((lease) => lease.state === "revoked");
        expect(grantedLease).toBeDefined();
        expect(revokedLease).toBeDefined();
        expect(revokedLease?.previous_lease_record_digest).toBe(grantedLease?.record_digest);
        expect(revokedLease?.command_id).toBe(
          `command_${contentDigest({
            purpose: "cancel-revoke",
            command_id: cancelCommandId,
            task_id: taskId,
            attempt_number: grantedLease?.attempt_number,
          }).slice(0, 24)}`,
        );
        // The revocation keeps the exact policy binding of the PolicyDecision
        // that authorized the grant; the cancel never rewrites history.
        expect(revokedLease?.policy_digest).toBe(grantedLease?.policy_digest);
        expect(revokedLease?.approval_digests).toEqual(grantedLease?.approval_digests);
        expect(verifyRecordEnvelope(revokedLease)).toBe(true);
      }
      expect(facts.wave_integrations).toEqual([]);

      // Crash/recovery equivalent: a brand-new host over the same persisted
      // Ledger/Git facts observes the durable cancellation and refuses to
      // dispatch anything for this operation again.
      const adapterInvocations: string[] = [];
      const recovered = createTestHost(fixture, {
        namespace: "ac17_recovered",
        run: (envelope, worktreeRoot) => {
          adapterInvocations.push(envelope.task_id);
          return writingAdapter(envelope, worktreeRoot);
        },
      });
      const rerun = await recovered.parallelExecution.port.run({
        ...runInput(fixture),
        driver_lock: recovered.parallelExecution.driverLock(),
      });
      expect(rerun.status).toBe("cancelled");
      expect(adapterInvocations).toEqual([]);

      const recoveredFacts = await authority.readFacts(fixture.operationId);
      expect(
        recoveredFacts.runs.filter((run) => run.record_kind === "run_terminated"),
      ).toHaveLength(2);
      expect(recoveredFacts.leases).toHaveLength(facts.leases.length);
      expect(recoveredFacts.wave_integrations).toEqual([]);
      const model = await recovered.readSchedulerModel(fixture.operationId);
      expect(
        model.tasks
          .filter((task) => task.status === "cancelled")
          .map((task) => task.task_id)
          .sort(),
      ).toEqual(["task_api", "task_ui"]);
    } finally {
      cleanupDirectories();
    }
  }, 120_000);
});
