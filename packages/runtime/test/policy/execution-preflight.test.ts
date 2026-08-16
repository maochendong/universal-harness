import { describe, expect, it } from "vitest";

import { compileContextBundle } from "../../src/context/compiler.js";
import { prepareExecutionPreflight } from "../../src/policy/execution-preflight.js";
import { createCapabilityGrantSpec } from "../../src/policy/capability-grant.js";
import { mergePolicyLayers } from "../../src/policy/evaluator.js";

import { BINDINGS, candidate } from "../context/fixtures.js";
import { grantRequest } from "./fixtures.js";

function fixture() {
  const bundle = compileContextBundle({
    taskId: "task_01",
    goal: "ship",
    bindings: BINDINGS,
    tokenBudget: 100,
    candidates: [candidate("requirement_01", "Requirement", 1, "ship")],
  }).record;
  const grantSpec = createCapabilityGrantSpec(grantRequest(), mergePolicyLayers([]).effective, {
    planDigest: BINDINGS.plan_digest,
    contextBundleDigest: bundle.digest,
    adapterProfileDigest: "3".repeat(64),
    baselineCommit: "a".repeat(40),
  });
  return { bundle, grantSpec };
}

describe("prepareExecutionPreflight", () => {
  it("binds every task, bundle, grant, coverage, policy, profile and baseline once", () => {
    const { bundle, grantSpec } = fixture();
    const result = prepareExecutionPreflight({
      authorizationId: "authorization_01",
      iterationId: "iteration_01",
      planDigest: BINDINGS.plan_digest,
      tasks: [{ taskId: "task_01", taskDigest: BINDINGS.task_digest, risk: "high" }],
      impactSetDigest: "6".repeat(64),
      impactCoverageDigest: BINDINGS.impact_coverage_digest,
      impactCoverageStatus: "complete",
      bundles: [bundle],
      grantSpecs: [grantSpec],
      policyDigest: grantSpec.effective_policy_digest,
      adapterProfileDigest: "3".repeat(64),
      baselineCommit: "a".repeat(40),
      requiresWrite: true,
      opaqueDelegated: true,
    });
    expect(result.authorizationSpec).toMatchObject({
      task_digests: [BINDINGS.task_digest],
      context_bundle_digests: [bundle.digest],
      grant_spec_digests: [grantSpec.spec_digest],
      effective_risk: "high",
    });
    expect(result.supervised).toBe(true);
  });

  it("rejects missing task bindings and incomplete coding coverage", () => {
    const { bundle, grantSpec } = fixture();
    const base = {
      authorizationId: "authorization_01",
      iterationId: "iteration_01",
      planDigest: BINDINGS.plan_digest,
      tasks: [{ taskId: "task_01", taskDigest: BINDINGS.task_digest, risk: "high" as const }],
      impactSetDigest: "6".repeat(64),
      impactCoverageDigest: BINDINGS.impact_coverage_digest,
      impactCoverageStatus: "complete" as const,
      bundles: [bundle],
      grantSpecs: [grantSpec],
      policyDigest: grantSpec.effective_policy_digest,
      adapterProfileDigest: "3".repeat(64),
      baselineCommit: "a".repeat(40),
      requiresWrite: true,
      opaqueDelegated: false,
    };
    expect(() => prepareExecutionPreflight({ ...base, bundles: [] })).toThrowError(
      expect.objectContaining({ kind: "missing_binding" }),
    );
    expect(() =>
      prepareExecutionPreflight({ ...base, impactCoverageStatus: "partial" }),
    ).toThrowError(expect.objectContaining({ kind: "impact_coverage_incomplete" }));
  });
});
