import { describe, expect, it } from "vitest";

import { contentDigest, type NodeRecord } from "../../packages/core/src/index.js";
import {
  acceptFinding,
  analyzeRootCause,
  assertWriteAllowed,
  buildFindingRecord,
  closeFinding,
  findingEdgeRecords,
  findingNodeRecord,
  readRootCauseContent,
  routeRevisionTask,
  type FeedbackError,
} from "../../packages/eval/src/index.js";
import {
  generateImpactSet,
  readImpactSetContent,
  seedFromFinding,
} from "../../packages/graph/src/index.js";
import {
  ToolRegistry,
  normalizeGateDefinition,
  runGateSuite,
  type CurrentEvidenceState,
  type GateDefinition,
  type GateSuiteOutcome,
} from "../../packages/runtime/src/index.js";
import {
  BINDING_DIGESTS,
  FIXED_TIMESTAMP,
  failingHandler,
  gateTool,
  passingHandler,
} from "../../packages/runtime/test/gates/fixtures.js";

/**
 * Feedback cascade integration (design 9.1, plan Task 21, completion rules
 * 17-19): a failed mandatory gate becomes a Finding, the Finding is
 * diagnosed into a structured RCA, the RCA seeds an ImpactSet and routes a
 * revision Task back to the owner phase -- a downstream writer can never
 * edit the upstream artifact directly -- and only current repair evidence
 * closes the Finding.
 */
const TIMESTAMP_CLOCK = (): string => FIXED_TIMESTAMP;
const CONTEXT = { actor: "workflow-engine", timestamp: FIXED_TIMESTAMP } as const;

const GATES: readonly GateDefinition[] = [
  normalizeGateDefinition({
    gate_id: "gate_integrity",
    layer: "universal",
    name: "gate_integrity",
    mandatory: true,
    subject_id: "test_smoke",
    tool: "run_integrity",
  }),
  normalizeGateDefinition({
    gate_id: "gate_build",
    layer: "stack",
    name: "gate_build",
    mandatory: true,
    subject_id: "test_smoke",
    tool: "run_build",
  }),
];

function registryWith(build: Parameters<ToolRegistry["register"]>[1]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(gateTool("run_integrity"), passingHandler());
  registry.register(gateTool("run_build"), build);
  return registry;
}

function suiteBindings() {
  return {
    artifact_digests: [BINDING_DIGESTS.artifact],
    code_digests: [BINDING_DIGESTS.code],
    context_bundle_digest: BINDING_DIGESTS.context,
    evaluation_case_digests: [BINDING_DIGESTS.evaluation],
    policy_digest: BINDING_DIGESTS.policy,
  };
}

function runSuite(registry: ToolRegistry): Promise<GateSuiteOutcome> {
  return runGateSuite(registry, {
    iterationId: "iteration_01",
    gates: GATES,
    bindings: suiteBindings(),
    clock: TIMESTAMP_CLOCK,
  });
}

function currentFor(): (gate: GateDefinition) => CurrentEvidenceState {
  return (gate) => ({ ...suiteBindings(), gate_digest: gate.digest });
}

function makeNode(id: string, type: NodeRecord["type"]): NodeRecord {
  const content = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id,
    type,
    revision: 1,
    status: "accepted",
    source: "human",
    provenance: { iteration_id: "iteration_01", actor: "human-1", timestamp: FIXED_TIMESTAMP },
    confidence: 1,
  };
  return { ...content, digest: contentDigest(content) } as unknown as NodeRecord;
}

describe("feedback cascade", () => {
  it("runs Finding -> RCA -> ImpactSet -> owner-phase revision -> current repair evidence", async () => {
    // 1. A mandatory stack gate fails and produces a bare Finding.
    const failed = await runSuite(registryWith(failingHandler()));
    expect(failed.completed_allowed).toBe(false);
    const bareFinding = failed.findings[0];
    expect(bareFinding?.id).toBe("finding_build");

    // The canonical Finding binds what it violates and what it blocks.
    const finding = buildFindingRecord({
      id: bareFinding?.id ?? "finding_build",
      iterationId: "iteration_01",
      summary: bareFinding?.summary ?? "",
      subject: {
        origin: "test",
        blocking: true,
        violates: ["constraint_build-green"],
        blocks: ["task_implement-feature"],
        evidence: ["evidence_build"],
      },
      clock: TIMESTAMP_CLOCK,
    });

    // 2. Deterministic RCA diagnoses the failure pattern.
    const rca = analyzeRootCause({
      id: "rca_build",
      finding,
      signal: {
        origin: "test",
        gateLayer: "stack",
        module: "packages/runtime",
        evidenceIds: ["evidence_build"],
      },
      clock: TIMESTAMP_CLOCK,
    });
    const diagnosis = readRootCauseContent(rca);
    expect(diagnosis.category).toBe("implementation_defect");
    expect(diagnosis.responsible_layer).toBe("architecture");
    expect(diagnosis.requires_human_review).toBe(false);

    // 3. The Finding seeds an ImpactSet over the artifact graph.
    const findingNode = findingNodeRecord(finding, CONTEXT);
    const constraintNode = makeNode("constraint_build-green", "Constraint");
    const taskNode = makeNode("task_implement-feature", "Task");
    const nodes = [findingNode, constraintNode, taskNode];
    const edges = findingEdgeRecords(finding, CONTEXT);
    const impactSet = generateImpactSet([seedFromFinding(findingNode, "bugfix")], nodes, edges, {
      iterationId: "iteration_01",
      actor: "workflow-engine",
      timestamp: FIXED_TIMESTAMP,
    });
    const impact = readImpactSetContent(impactSet);
    const constraintEntry = impact.entries.find(
      (entry) => entry.node_id === "constraint_build-green",
    );
    expect(constraintEntry?.classification).toBe("must-change");

    // 4. The Workflow Engine routes the revision to the owner phase; the
    //    downstream implementation phase may not touch the artifact itself.
    expect(() => assertWriteAllowed("implementation", "architecture")).toThrowError(
      expect.objectContaining({ kind: "upstream_write_forbidden" }) as FeedbackError,
    );
    const routing = routeRevisionTask({
      rca,
      targetNodeIds: ["constraint_build-green"],
      impactPaths: constraintEntry === undefined ? [] : [constraintEntry.path],
      taskId: "task_revise-build-green",
      requiredGates: ["gate_build"],
    });
    expect(routing.owner_phase).toBe("architecture");
    expect(routing.task.expected_outputs).toEqual(["constraint_build-green"]);

    // 5. After the repair lands, the gate re-runs green and the current
    //    evidence closes the accepted Finding.
    const repaired = await runSuite(registryWith(passingHandler()));
    expect(repaired.completed_allowed).toBe(true);
    const repairEvidence = repaired.results.find(
      (result) => result.gate.gate_id === "gate_build",
    )?.evidence;
    expect(repairEvidence).toBeDefined();
    if (repairEvidence === undefined) throw new Error("repair evidence missing");
    const accepted = acceptFinding(finding);
    const closed = closeFinding(accepted, repairEvidence, currentFor()(GATES[1] as GateDefinition));
    expect(closed.status).toBe("closed");
  });

  it("never closes a Finding with stale repair evidence", async () => {
    const failed = await runSuite(registryWith(failingHandler()));
    const finding = buildFindingRecord({
      id: failed.findings[0]?.id ?? "finding_build",
      iterationId: "iteration_01",
      summary: failed.findings[0]?.summary ?? "",
      subject: {
        origin: "test",
        blocking: true,
        violates: ["constraint_build-green"],
        blocks: ["task_implement-feature"],
        evidence: ["evidence_build"],
      },
      clock: TIMESTAMP_CLOCK,
    });
    const repaired = await runSuite(registryWith(passingHandler()));
    const repairEvidence = repaired.results.find(
      (result) => result.gate.gate_id === "gate_build",
    )?.evidence;
    if (repairEvidence === undefined) throw new Error("repair evidence missing");

    // The effective policy drifted after the repair run: the once-green
    // evidence is stale and cannot close the Finding.
    const drifted = {
      ...currentFor()(GATES[1] as GateDefinition),
      policy_digest: "6".repeat(64),
    };
    expect(() => closeFinding(finding, repairEvidence, drifted)).toThrowError(
      expect.objectContaining({ kind: "stale_evidence" }) as FeedbackError,
    );
  });
});
