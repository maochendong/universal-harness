import { describe, expect, it } from "vitest";

import { ActionIntentJournal, type ActionIntentRecord } from "../../src/tools/action-intent.js";
import { reconcileIntent, reconcileJournal } from "../../src/tools/reconciliation.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { contentDigest } from "@universal-harness-internal/core";
import { externalTool, okHandler } from "./fixtures.js";

/**
 * Uncertain-result reconciliation (design 13.5, 15.2): resume reconciles
 * every unresolved intent before any retry. Applied effects are reused,
 * provably unapplied effects may be retried, and everything else requires a
 * human -- a timeout never implies the external action did not happen.
 */
function intent(overrides?: Partial<ActionIntentRecord>): ActionIntentRecord {
  return {
    intent_id: "intent_01",
    tool: "issue_comment@1.0.0",
    request_digest: contentDigest({ body: "hello" }),
    resource: "issue:42",
    approval_digest: null,
    idempotency_key: "op-1",
    status: "uncertain",
    result_digest: null,
    ...overrides,
  };
}

function registryWith(definition: Record<string, unknown>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(definition, okHandler());
  return registry;
}

describe("reconcileIntent", () => {
  it("reuses the result when the provider proves the effect applied", async () => {
    const registry = registryWith(externalTool());
    const decision = await reconcileIntent(intent(), registry, () => "applied");
    expect(decision.decision).toBe("reuse_result");
  });

  it("allows retry when the provider proves the effect was not applied", async () => {
    const registry = registryWith(externalTool());
    const decision = await reconcileIntent(intent(), registry, () => "not_applied");
    expect(decision.decision).toBe("retry_allowed");
  });

  it("requires a human when the provider cannot tell", async () => {
    const registry = registryWith(externalTool());
    const decision = await reconcileIntent(intent(), registry, () => "unknown");
    expect(decision.decision).toBe("manual_required");
  });

  it("requires a human when no probe exists", async () => {
    const registry = registryWith(externalTool());
    const decision = await reconcileIntent(intent(), registry);
    expect(decision.decision).toBe("manual_required");
    expect(decision.reason).toContain("never");
  });

  it("requires a human for tools declared manual regardless of the probe", async () => {
    const registry = registryWith(externalTool({ reconciliation: "manual" }));
    const decision = await reconcileIntent(intent(), registry, () => "applied");
    expect(decision.decision).toBe("manual_required");
  });

  it("requires a human when the tool is no longer registered", async () => {
    const decision = await reconcileIntent(intent(), new ToolRegistry(), () => "applied");
    expect(decision.decision).toBe("manual_required");
  });
});

describe("reconcileJournal", () => {
  it("reconciles every unresolved intent in deterministic order", async () => {
    const registry = registryWith(externalTool());
    const journal = ActionIntentJournal.restore([
      intent({ intent_id: "intent_b", idempotency_key: "op-b", status: "uncertain" }),
      intent({ intent_id: "intent_a", idempotency_key: "op-a", status: "pending" }),
      intent({ intent_id: "intent_c", idempotency_key: "op-c", status: "completed" }),
    ]);
    const decisions = await reconcileJournal(journal, registry, (record) =>
      record.intent_id === "intent_a" ? "not_applied" : "applied",
    );
    expect(decisions.map((decision) => decision.intent_id)).toEqual(["intent_a", "intent_b"]);
    expect(decisions.map((decision) => decision.decision)).toEqual([
      "retry_allowed",
      "reuse_result",
    ]);
  });
});
