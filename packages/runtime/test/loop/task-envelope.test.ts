import { describe, expect, it } from "vitest";

import { LoopError } from "../../src/loop/policy.js";
import { isTaskEnvelope } from "../../src/loop/task-envelope.js";

import { makeEnvelope } from "./fixtures.js";

describe("buildTaskEnvelope", () => {
  it("builds a deterministic, content-digested envelope", () => {
    const envelope = makeEnvelope();
    expect(envelope.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(isTaskEnvelope(envelope)).toBe(true);
    expect(makeEnvelope()).toEqual(envelope);
  });

  it("normalizes path sets and sorts tools for a stable digest", () => {
    const envelope = makeEnvelope({
      allowed_read_paths: ["src\\nested", "./src"],
      proposed_write_paths: ["src"],
      tools: [{ name: "run_tests" }, { name: "apply_patch" }],
    });
    expect(envelope.allowed_read_paths).toEqual(["src", "src/nested"]);
    expect(envelope.tools.map((tool) => tool.name)).toEqual(["apply_patch", "run_tests"]);
  });

  it("rejects structurally invalid envelopes with a typed error", () => {
    expect(() => makeEnvelope({ objective: "" })).toThrowError(LoopError);
    expect(() => makeEnvelope({ context_bundle_digest: "not-a-digest" })).toThrowError(
      /invalid_task_envelope|structural/u,
    );
    expect(() => makeEnvelope({ risk: "extreme" as never })).toThrowError(LoopError);
  });
});

describe("isTaskEnvelope", () => {
  it("rejects tampered records on read-back", () => {
    const envelope = makeEnvelope();
    expect(isTaskEnvelope({ ...envelope, risk: "extreme" })).toBe(false);
    expect(isTaskEnvelope({ ...envelope, loop_policy: { max_steps: 1 } })).toBe(false);
    expect(isTaskEnvelope(null)).toBe(false);
    expect(isTaskEnvelope({ ...envelope, stale_input_behavior: "ignore" })).toBe(false);
  });
});
