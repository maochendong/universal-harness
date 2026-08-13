import { describe, expect, it, vi } from "vitest";

import { ActionIntentJournal } from "../../packages/runtime/src/tools/action-intent.js";
import { ToolError } from "../../packages/runtime/src/tools/definition.js";
import {
  invokeTool,
  type ToolInvocationRequest,
} from "../../packages/runtime/src/tools/invocation.js";
import { reconcileJournal } from "../../packages/runtime/src/tools/reconciliation.js";
import { ToolRegistry } from "../../packages/runtime/src/tools/registry.js";
import {
  externalTool,
  hangingHandler,
  okHandler,
} from "../../packages/runtime/test/tools/fixtures.js";
import {
  SimulatedProcessKill,
  SimulatedTimeout,
  UncertainCommitResult,
} from "../helpers/fault-injection.js";

/**
 * Uncertain external action fault injection (design 13.5, 15.2; error table
 * row "External Action Result 不确定"). The shared fault helpers stand in for
 * process death, hangs and unknowable outcomes at the side-effect boundary.
 * Invariants: the intent is committed before the effect, a timeout or crash
 * never implies the effect did not happen, nothing retries an unresolved key
 * blindly, and reconciliation -- not replay -- decides what happens next.
 */
const APPROVAL = "d".repeat(64);

function request(overrides?: Partial<ToolInvocationRequest>): ToolInvocationRequest {
  return {
    intent_id: "intent_01",
    tool: "issue_comment",
    phase: "implementation",
    resource: "issue:42",
    parameters: { url: "https://example.test/issue/42" },
    approval_digest: APPROVAL,
    idempotency_key: "op-1",
    ...overrides,
  };
}

const validateApproval = (): boolean => true;

function registryWithHandler(handler: Parameters<ToolRegistry["register"]>[1]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(externalTool({ timeout_ms: 10 }), handler);
  return registry;
}

async function uncertainCall(
  registry: ToolRegistry,
  journal: ActionIntentJournal,
  req: ToolInvocationRequest,
): Promise<ToolError> {
  try {
    await invokeTool(registry, req, { journal, validateApproval });
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }
  throw new Error("expected the call to fail");
}

describe("uncertain external action recovery", () => {
  it("never replays a timed-out side effect blindly; reuse follows reconciliation", async () => {
    const applied: string[] = [];
    const journal = new ActionIntentJournal();
    // The provider applies the effect, then the connection hangs: the caller
    // can only observe a timeout, not the outcome.
    const registry = registryWithHandler(() => {
      applied.push("issue:42");
      return new Promise(() => undefined);
    });

    const failure = await uncertainCall(registry, journal, request());
    expect(failure.kind).toBe("uncertain_result");
    expect(applied).toEqual(["issue:42"]);
    expect(journal.get("intent_01")?.status).toBe("uncertain");
    expect(journal.workingStateIntents()[0]?.status).toBe("uncertain");

    // A blind retry is refused: the key is unresolved, so the effect must not
    // be applied a second time.
    const blindRetry = await uncertainCall(registry, journal, request({ intent_id: "intent_02" }));
    expect(blindRetry.kind).toBe("reconciliation_required");
    expect(applied).toEqual(["issue:42"]);

    // Reconciliation proves the effect applied: reuse it, never replay it.
    const decisions = await reconcileJournal(journal, registry, () => "applied");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("reuse_result");
    const intent = journal.get("intent_01");
    expect(intent).toBeDefined();
    journal.markReconciledApplied(intent as NonNullable<typeof intent>);
    expect(journal.unresolved()).toHaveLength(0);

    const replayed = await invokeTool(registry, request({ intent_id: "intent_03" }), {
      journal,
      validateApproval,
    });
    expect(replayed.replayed).toBe(true);
    expect(applied).toEqual(["issue:42"]);
  });

  it("retries exactly once after a process kill when reconciliation proves no effect", async () => {
    const applied: string[] = [];
    const journal = new ActionIntentJournal();
    let calls = 0;
    const registry = registryWithHandler(() => {
      calls += 1;
      if (calls === 1) throw new SimulatedProcessKill("staged-tree");
      applied.push("issue:42");
      return { status: "ok" };
    });

    const failure = await uncertainCall(registry, journal, request());
    // A crash mid-call leaves the outcome unknowable: uncertain, not failed.
    expect(failure.kind).toBe("uncertain_result");
    expect(applied).toEqual([]);

    const decisions = await reconcileJournal(journal, registry, () => "not_applied");
    expect(decisions[0]?.decision).toBe("retry_allowed");
    const intent = journal.get("intent_01");
    journal.releaseForRetry(intent as NonNullable<typeof intent>);

    const retried = await invokeTool(registry, request({ intent_id: "intent_02" }), {
      journal,
      validateApproval,
    });
    expect(retried.intent?.status).toBe("completed");
    expect(applied).toEqual(["issue:42"]);
  });

  it("forces manual review when the provider cannot prove the outcome", async () => {
    const journal = new ActionIntentJournal();
    const registry = registryWithHandler(() => {
      throw new UncertainCommitResult("target-files");
    });
    const failure = await uncertainCall(registry, journal, request());
    expect(failure.kind).toBe("uncertain_result");

    const decisions = await reconcileJournal(journal, registry, () => "unknown");
    expect(decisions[0]?.decision).toBe("manual_required");
    // And a manual-required intent still blocks automatic retry.
    const blocked = await uncertainCall(registry, journal, request({ intent_id: "intent_02" }));
    expect(blocked.kind).toBe("reconciliation_required");
  });

  it("treats a definite provider timeout error as uncertain for external tools", async () => {
    const journal = new ActionIntentJournal();
    const registry = registryWithHandler(() => {
      throw new SimulatedTimeout("staged-tree");
    });
    const failure = await uncertainCall(registry, journal, request());
    expect(failure.kind).toBe("uncertain_result");
    expect(journal.get("intent_01")?.status).toBe("uncertain");
  });

  it("records a completed intent but refuses invalid output without retrying", async () => {
    const handler = vi.fn(okHandler({ unexpected: true }));
    const journal = new ActionIntentJournal();
    const registry = registryWithHandler(handler);
    const failure = await uncertainCall(registry, journal, request());
    expect(failure.kind).toBe("invalid_output");
    // The provider responded: the effect applied (intent completed), the
    // protocol violation is surfaced, and nothing re-executes the effect.
    expect(journal.get("intent_01")?.status).toBe("completed");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps the uncertain intent in the checkpoint projection", async () => {
    const journal = new ActionIntentJournal();
    const registry = registryWithHandler(hangingHandler());
    await uncertainCall(registry, journal, request());
    const projection = journal.workingStateIntents();
    expect(projection).toHaveLength(1);
    expect(projection[0]).toMatchObject({
      intent_id: "intent_01",
      tool: "issue_comment@1.0.0",
      idempotency_key: "op-1",
      status: "uncertain",
    });
  });
});
