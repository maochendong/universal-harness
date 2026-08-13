import { describe, expect, it } from "vitest";

import { contentDigest } from "../../packages/core/src/index.js";
import {
  ToolRegistry,
  bindingDrift,
  compileContextBundle,
  completionBlockers,
  evidenceStalenessReasons,
  findingClosableBy,
  invalidateContextBundle,
  isContextBundleStale,
  isEvidenceStale,
  normalizeGateDefinition,
  runGateSuite,
  stalenessReasons,
  type ApprovalBindingSnapshot,
  type ApprovalRequestRecord,
  type CurrentEvidenceState,
} from "../../packages/runtime/src/index.js";
import { BINDINGS, candidate } from "../../packages/runtime/test/context/fixtures.js";
import {
  BINDING_DIGESTS,
  FIXED_TIMESTAMP,
  gateTool,
  passingHandler,
} from "../../packages/runtime/test/gates/fixtures.js";

/**
 * Approval cascade invalidation (design 15.3, completion rule 20; plan Task
 * 27 step 2). A change to a Requirement, Policy or Impact input after
 * approval cascades deterministically: the approval binding drifts, the
 * compiled ContextBundle goes stale, bound Evidence goes stale, and stale
 * evidence can neither close a Finding nor satisfy completion. Invalidation
 * is append-only and idempotent.
 */
const REQUEST: ApprovalRequestRecord = {
  protocol_version: "1.0.0",
  record_kind: "approval_request",
  request_id: "approval-request_cascade",
  workflow_operation_id: "workflow-op_cascade",
  object_id: "plan_01",
  object_type: "ExecutionPlan",
  object_digest: "c".repeat(64),
  baseline_digest: "a".repeat(64),
  policy_digest: BINDINGS.policy_digest,
  impact_path: ["edge_impact01", "edge_impact02"],
  risk: "high",
  reason: "plan approval",
  allowed_decisions: ["approve", "reject", "defer"],
  created_at: FIXED_TIMESTAMP,
  resume_phase: "planned",
  preview_digest: "f".repeat(64),
} as ApprovalRequestRecord;

function currentBinding(overrides?: Partial<ApprovalBindingSnapshot>): ApprovalBindingSnapshot {
  return {
    objectDigest: REQUEST.object_digest,
    baselineDigest: REQUEST.baseline_digest,
    policyDigest: REQUEST.policy_digest,
    impactPath: [...REQUEST.impact_path],
    ...overrides,
  };
}

describe("approval binding cascade", () => {
  it("flags every drifted binding item in a stable order", () => {
    expect(bindingDrift(REQUEST, currentBinding())).toEqual([]);
    expect(bindingDrift(REQUEST, currentBinding({ objectDigest: "0".repeat(64) }))).toEqual([
      "object_digest",
    ]);
    expect(bindingDrift(REQUEST, currentBinding({ baselineDigest: "1".repeat(64) }))).toEqual([
      "baseline_digest",
    ]);
    expect(bindingDrift(REQUEST, currentBinding({ policyDigest: "2".repeat(64) }))).toEqual([
      "policy_digest",
    ]);
    expect(bindingDrift(REQUEST, currentBinding({ impactPath: ["edge_impact01"] }))).toEqual([
      "impact_path",
    ]);
    // A requirement change cascading into object + impact drift is reported
    // together, in the canonical order.
    expect(
      bindingDrift(
        REQUEST,
        currentBinding({ objectDigest: "0".repeat(64), impactPath: ["edge_impact09"] }),
      ),
    ).toEqual(["object_digest", "impact_path"]);
  });
});

describe("context bundle cascade", () => {
  function compileBound() {
    return compileContextBundle({
      taskId: "task_cascade",
      goal: "cascade invalidation",
      bindings: BINDINGS,
      tokenBudget: 10_000,
      candidates: [candidate("requirement_01", "Requirement", 1, "the requirement statement")],
    });
  }

  it("goes stale when any bound digest changes, and invalidates append-only", () => {
    const bundle = compileBound();
    const sourceDigests = new Map(
      bundle.manifest.entries.map((entry) => [entry.node_id, entry.digest]),
    );
    expect(isContextBundleStale(bundle.manifest, { sourceDigests, bindings: BINDINGS })).toBe(
      false,
    );

    // A policy change invalidates the bundle with a precise reason.
    const drifted = {
      sourceDigests,
      bindings: { ...BINDINGS, policy_digest: "9".repeat(64) },
    };
    expect(stalenessReasons(bundle.manifest, drifted)).toEqual(["policy digest changed"]);

    // A requirement change invalidates the bundle too.
    const requirementDrift = {
      sourceDigests,
      bindings: { ...BINDINGS, requirement_baseline_digest: "8".repeat(64) },
    };
    expect(stalenessReasons(bundle.manifest, requirementDrift)).toEqual([
      "requirement baseline digest changed",
    ]);

    // Invalidation never rewrites history: same digest, stale flag flipped,
    // and repeating it collapses to the same record.
    const invalidated = invalidateContextBundle(bundle.record);
    expect(invalidated.stale).toBe(true);
    expect(invalidated.digest).toBe(bundle.record.digest);
    expect(invalidateContextBundle(invalidated)).toBe(invalidated);
  });
});

describe("evidence cascade", () => {
  async function runBoundSuite() {
    const registry = new ToolRegistry();
    registry.register(gateTool("unit_tests"), passingHandler());
    const gate = normalizeGateDefinition({
      gate_id: "gate_unit",
      layer: "universal",
      name: "unit tests",
      mandatory: true,
      subject_id: "test_smoke",
      tool: "unit_tests",
    });
    return runGateSuite(registry, {
      iterationId: "iteration_01",
      gates: [gate],
      bindings: {
        artifact_digests: [BINDING_DIGESTS.artifact],
        code_digests: [BINDING_DIGESTS.code],
        context_bundle_digest: BINDING_DIGESTS.context,
        evaluation_case_digests: [BINDING_DIGESTS.evaluation],
        policy_digest: BINDING_DIGESTS.policy,
      },
      clock: () => FIXED_TIMESTAMP,
    });
  }

  function currentState(overrides?: Partial<CurrentEvidenceState>): CurrentEvidenceState {
    return {
      artifact_digests: [BINDING_DIGESTS.artifact],
      code_digests: [BINDING_DIGESTS.code],
      context_bundle_digest: BINDING_DIGESTS.context,
      gate_digest: "",
      evaluation_case_digests: [BINDING_DIGESTS.evaluation],
      policy_digest: BINDING_DIGESTS.policy,
      ...overrides,
    };
  }

  it("stales evidence on input drift and blocks both finding closure and completion", async () => {
    const outcome = await runBoundSuite();
    const result = outcome.results[0];
    expect(result?.outcome.passed).toBe(true);
    const evidence = result?.evidence;
    expect(evidence).toBeDefined();
    if (evidence === undefined || result === undefined) return;

    const current = currentState({ gate_digest: result.gate.digest });
    expect(isEvidenceStale(evidence, current)).toBe(false);
    expect(findingClosableBy(evidence, current)).toBe(true);
    expect(completionBlockers(outcome, () => current)).toEqual([]);

    // A policy change after the run: the evidence is stale everywhere.
    const drifted = { ...current, policy_digest: "7".repeat(64) };
    expect(evidenceStalenessReasons(evidence, drifted)).toEqual(["bound policy digest changed"]);
    expect(findingClosableBy(evidence, drifted)).toBe(false);
    const blockers = completionBlockers(outcome, () => drifted);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("evidence is stale");

    // A requirement/code change stales the evidence as well.
    const codeDrift = { ...current, code_digests: ["6".repeat(64)] };
    expect(evidenceStalenessReasons(evidence, codeDrift)).toEqual(["bound code set changed"]);
  });
});

describe("single-change cascade", () => {
  it("one policy change invalidates approval, bundle and evidence together", () => {
    // Approval binding drifts.
    const drift = bindingDrift(REQUEST, currentBinding({ policyDigest: "9".repeat(64) }));
    expect(drift).toEqual(["policy_digest"]);
    // The bundle binding the same policy digest goes stale.
    const bundle = compileContextBundle({
      taskId: "task_cascade",
      goal: "cascade invalidation",
      bindings: BINDINGS,
      tokenBudget: 10_000,
      candidates: [candidate("requirement_01", "Requirement", 1, "statement")],
    });
    const sourceDigests = new Map(
      bundle.manifest.entries.map((entry) => [entry.node_id, entry.digest]),
    );
    expect(
      isContextBundleStale(bundle.manifest, {
        sourceDigests,
        bindings: { ...BINDINGS, policy_digest: "9".repeat(64) },
      }),
    ).toBe(true);
    // And the approval identity itself is content-bound: the digested record
    // changes when any binding input changes.
    expect(contentDigest({ ...REQUEST, policy_digest: "9".repeat(64) })).not.toBe(
      contentDigest(REQUEST),
    );
  });
});
