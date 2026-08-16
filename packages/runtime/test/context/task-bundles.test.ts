import { describe, expect, it } from "vitest";

import { compileContextBundle } from "../../src/context/compiler.js";
import { assertTaskBundleBinding } from "../../src/context/task-bundles.js";

import { BINDINGS, candidate } from "./fixtures.js";

describe("assertTaskBundleBinding", () => {
  it("accepts the owning task and rejects cross-task reuse and digest drift", () => {
    const record = compileContextBundle({
      taskId: "task_alpha",
      goal: "ship",
      bindings: BINDINGS,
      tokenBudget: 100,
      candidates: [candidate("requirement_01", "Requirement", 1, "ship")],
    }).record;
    const expected = {
      taskId: "task_alpha",
      taskDigest: BINDINGS.task_digest,
      planDigest: BINDINGS.plan_digest,
      impactCoverageDigest: BINDINGS.impact_coverage_digest,
    };
    expect(() => assertTaskBundleBinding(record, expected)).not.toThrow();
    expect(() =>
      assertTaskBundleBinding(record, { ...expected, taskId: "task_beta" }),
    ).toThrowError(expect.objectContaining({ kind: "binding_drift" }));
    expect(() =>
      assertTaskBundleBinding(record, { ...expected, taskDigest: "0".repeat(64) }),
    ).toThrowError(expect.objectContaining({ kind: "binding_drift" }));
  });
});
