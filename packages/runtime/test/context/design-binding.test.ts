import { describe, expect, it } from "vitest";

import { contentDigest } from "../../../core/src/index.js";

import { compileContextBundle, type BundleBindings } from "../../src/context/compiler.js";
import { stalenessReasons } from "../../src/context/freshness.js";
import { TaskBundleBindingError, assertTaskBundleBinding } from "../../src/context/task-bundles.js";

/**
 * T14 capability-conditional context bindings: the design_set_digest enters
 * the bundle manifest only when design_governance is active; freshness and
 * the preflight binding check treat any drift — or a forbidden pseudo
 * binding on a design-less bundle — as stale/binding_drift.
 */
const digest = (letter: string) => letter.repeat(64);

function bindings(extra?: { design_set_digest?: string }): BundleBindings {
  return {
    requirement_baseline_digest: digest("b"),
    policy_digest: digest("2"),
    plan_digest: digest("3"),
    impact_coverage_digest: digest("4"),
    task_digest: digest("5"),
    approval_digests: [],
    ...extra,
  };
}

function testNode() {
  const nodeRecord: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: "requirement_01",
    type: "Requirement",
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "context-test",
      timestamp: "2026-08-21T00:00:00Z",
    },
    confidence: 1,
  };
  return { ...nodeRecord, digest: contentDigest(nodeRecord) } as never;
}

function compile(extra?: { design_set_digest?: string }) {
  const node = testNode();
  return compileContextBundle({
    taskId: "task_01",
    goal: "goal",
    bindings: bindings(extra),
    tokenBudget: 4000,
    candidates: [{ node, content: "requirement text", tier: 1, reason: "the requirement" }],
  });
}

describe("conditional design_set_digest binding", () => {
  it("carries the binding only when design governance supplies it", () => {
    const withDesign = compile({ design_set_digest: digest("d") });
    expect(withDesign.manifest.bindings.design_set_digest).toBe(digest("d"));

    const without = compile();
    expect(without.manifest.bindings.design_set_digest).toBeUndefined();
    expect("design_set_digest" in without.manifest.bindings).toBe(false);
  });

  it("flags design set drift as stale", () => {
    const compiled = compile({ design_set_digest: digest("d") });
    const entryDigest = compiled.manifest.entries[0]?.digest ?? "";
    const current = {
      sourceDigests: new Map([["requirement_01", entryDigest]]),
      bindings: bindings({ design_set_digest: digest("e") }),
    };
    expect(stalenessReasons(compiled.manifest, current)).toContain("design set digest changed");

    const fresh = {
      sourceDigests: new Map([["requirement_01", entryDigest]]),
      bindings: bindings({ design_set_digest: digest("d") }),
    };
    expect(stalenessReasons(compiled.manifest, fresh)).toEqual([]);
  });

  it("rejects preflight reuse when the design binding drifts or is forged", () => {
    const compiled = compile({ design_set_digest: digest("d") });
    const base = {
      taskId: "task_01",
      taskDigest: digest("5"),
      planDigest: digest("3"),
      impactCoverageDigest: digest("4"),
    };
    expect(() =>
      assertTaskBundleBinding(compiled.record, { ...base, designSetDigest: digest("d") }),
    ).not.toThrow();
    expect(() =>
      assertTaskBundleBinding(compiled.record, { ...base, designSetDigest: digest("e") }),
    ).toThrowError(TaskBundleBindingError);
    // A design-less expectation must reject a bundle carrying the binding.
    expect(() => assertTaskBundleBinding(compiled.record, base)).toThrowError(
      TaskBundleBindingError,
    );
    // And a design-active expectation rejects a bundle missing it.
    const plain = compile();
    expect(() =>
      assertTaskBundleBinding(plain.record, { ...base, designSetDigest: digest("d") }),
    ).toThrowError(TaskBundleBindingError);
  });

  it("keeps the manifest digest deterministic with and without the binding", () => {
    const first = compile({ design_set_digest: digest("d") });
    const replay = compile({ design_set_digest: digest("d") });
    expect(replay.manifest.content_digest).toBe(first.manifest.content_digest);
    expect(compile().manifest.content_digest).not.toBe(first.manifest.content_digest);
    expect(contentDigest(first.manifest.bindings)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
