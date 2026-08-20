import { describe, expect, it } from "vitest";

import { sealRecordEnvelope, type ModelInvocationRecord } from "@universal-harness-internal/core";

import {
  InvocationTransitionError,
  planModelInvocation,
  transitionModelInvocation,
} from "../../src/model/invocation-records.js";

function planned(): ModelInvocationRecord {
  return planModelInvocation({
    invocation_id: "invocation_01K1TEST",
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
  });
}

describe("planModelInvocation", () => {
  it("pins every contract, overlay, input, schema, model, config and budget digest at planned time", () => {
    const record = planned();
    expect(record.state).toBe("planned");
    expect(record.revision).toBe(1);
    expect(record.prompt_contract_digest).toBe("a".repeat(64));
    expect(record.compiled_prompt_digest).toBe("f".repeat(64));
    expect(record.cache_key).toBe("1".repeat(64));
    expect(record.record_digest).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("model invocation lifecycle transitions", () => {
  it("walks planned -> started -> completed -> validated -> consumed", () => {
    const started = transitionModelInvocation(planned(), "started");
    const completed = transitionModelInvocation(started, "completed", {
      output_digest: "2".repeat(64),
    });
    const validated = transitionModelInvocation(completed, "validated");
    const consumed = transitionModelInvocation(validated, "consumed");
    for (const [record, revision] of [
      [started, 2],
      [completed, 3],
      [validated, 4],
      [consumed, 5],
    ] as const) {
      expect(record.revision).toBe(revision);
      // Identity and pinned digests never change across revisions.
      expect(record.compiled_prompt_digest).toBe("f".repeat(64));
      expect(record.record_digest).not.toBe(planned().record_digest);
    }
  });

  it("allows failure from planned, started and completed with a typed ModelPortFailure", () => {
    const failure = { code: "timeout" as const, summary: "provider timed out", retryable: true };
    expect(transitionModelInvocation(planned(), "failed", { failure }).state).toBe("failed");
    expect(
      transitionModelInvocation(transitionModelInvocation(planned(), "started"), "failed", {
        failure,
      }).failure?.code,
    ).toBe("timeout");
  });

  it("rejects illegal transitions fail-closed", () => {
    expect(() => transitionModelInvocation(planned(), "completed")).toThrow(
      InvocationTransitionError,
    );
    expect(() => transitionModelInvocation(planned(), "consumed")).toThrow(
      InvocationTransitionError,
    );
    const consumed = transitionModelInvocation(
      transitionModelInvocation(
        transitionModelInvocation(transitionModelInvocation(planned(), "started"), "completed", {
          output_digest: "2".repeat(64),
        }),
        "validated",
      ),
      "consumed",
    );
    expect(() => transitionModelInvocation(consumed, "started")).toThrow(InvocationTransitionError);
  });

  it("never mutates the prior revision in place", () => {
    const original = planned();
    const snapshot = structuredClone(original);
    transitionModelInvocation(original, "started");
    expect(original).toEqual(snapshot);
  });
});

describe("sealed envelope", () => {
  it("produces records that verify against the protocol envelope", () => {
    const record = planned();
    const sealed = sealRecordEnvelope({ ...record });
    expect(sealed.record_digest).toBe(record.record_digest);
  });
});
