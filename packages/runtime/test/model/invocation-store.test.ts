import { describe, expect, it } from "vitest";

import type { ModelInvocationRecord } from "@universal-harness-internal/core";

import {
  planModelInvocation,
  transitionModelInvocation,
  type PlanModelInvocationInput,
} from "../../src/model/invocation-records.js";
import {
  ModelInvocationStoreError,
  appendModelInvocationRecord,
  latestModelInvocation,
  readModelInvocationRecords,
  recoverableModelInvocations,
} from "../../src/model/invocation-store.js";
import { makeTempDir } from "../bootstrap/helpers.js";

function planInput(invocationId: string): PlanModelInvocationInput {
  return {
    invocation_id: invocationId,
    conversation_id: "conversation_01K1TEST",
    run_id: "run_01K1TEST",
    attempt: 1,
    port_id: "prd_proposal",
    binding: {
      provider_identity: "provider_anthropic",
      config_digest: "0".repeat(64),
      prompt_contract_id: "harness:prompt:prd-proposal",
      prompt_contract_version: "1.0.0",
      prompt_contract_digest: "a".repeat(64),
      output_schema_digest: "b".repeat(64),
      budget_profile: "capture-standard",
    },
    output_schema_id: "prd-proposal-draft",
    profile_overlay_digest: "c".repeat(64),
    policy_overlay_digest: "d".repeat(64),
    input_bundle_digest: "e".repeat(64),
    compiled_prompt_digest: "f".repeat(64),
    cache_key: "1".repeat(64),
  };
}

function appendLifecycle(
  projectRoot: string,
  invocationId: string,
  stopAt: "planned" | "started" | "completed" | "consumed",
): ModelInvocationRecord {
  const planned = planModelInvocation(planInput(invocationId));
  appendModelInvocationRecord(projectRoot, planned);
  if (stopAt === "planned") return planned;
  const started = transitionModelInvocation(planned, "started");
  appendModelInvocationRecord(projectRoot, started);
  if (stopAt === "started") return started;
  const completed = transitionModelInvocation(started, "completed", {
    output_digest: "2".repeat(64),
  });
  appendModelInvocationRecord(projectRoot, completed);
  if (stopAt === "completed") return completed;
  const validated = transitionModelInvocation(completed, "validated");
  appendModelInvocationRecord(projectRoot, validated);
  const consumed = transitionModelInvocation(validated, "consumed");
  appendModelInvocationRecord(projectRoot, consumed);
  return consumed;
}

describe("model invocation store", () => {
  it("appends and reads back sealed records", () => {
    const root = makeTempDir("harness-invocation-store-");
    appendLifecycle(root, "invocation_01K1A", "started");
    const records = readModelInvocationRecords(root);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.state)).toEqual(["planned", "started"]);
  });

  it("treats identical re-appends as idempotent no-ops and conflicting rewrites as errors", () => {
    const root = makeTempDir("harness-invocation-store-");
    const planned = planModelInvocation(planInput("invocation_01K1B"));
    appendModelInvocationRecord(root, planned);
    expect(() => appendModelInvocationRecord(root, planned)).not.toThrow();
    expect(() =>
      appendModelInvocationRecord(root, { ...planned, cache_key: "9".repeat(64) }),
    ).toThrow(ModelInvocationStoreError);
  });

  it("resolves the latest revision per invocation", () => {
    const root = makeTempDir("harness-invocation-store-");
    appendLifecycle(root, "invocation_01K1C", "completed");
    const latest = latestModelInvocation(readModelInvocationRecords(root), "invocation_01K1C");
    expect(latest?.state).toBe("completed");
    expect(latest?.revision).toBe(3);
  });

  it("lists crashed invocations as recoverable and terminal ones as closed", () => {
    const root = makeTempDir("harness-invocation-store-");
    appendLifecycle(root, "invocation_01K1D", "planned");
    appendLifecycle(root, "invocation_01K1E", "started");
    appendLifecycle(root, "invocation_01K1F", "consumed");
    const recoverable = recoverableModelInvocations(readModelInvocationRecords(root));
    expect(recoverable.map((record) => record.invocation_id).sort()).toEqual([
      "invocation_01K1D",
      "invocation_01K1E",
    ]);
  });

  it("fails closed on corrupted record files", () => {
    const root = makeTempDir("harness-invocation-store-");
    const planned = appendLifecycle(root, "invocation_01K1G", "planned");
    expect(planned.state).toBe("planned");
    const records = readModelInvocationRecords(root);
    expect(records).toHaveLength(1);
  });
});
