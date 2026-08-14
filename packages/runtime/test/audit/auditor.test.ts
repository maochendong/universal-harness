import { describe, expect, it } from "vitest";

import { contentDigest, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";

import { auditGraph, type AuditGraph } from "../../src/audit/auditor.js";

const FIXED_NOW = "2026-08-12T00:00:00.000Z";

interface NodeSpec {
  readonly id: string;
  readonly type: NodeRecord["type"];
  readonly revision?: number;
  readonly status?: NodeRecord["status"];
  readonly locator?: string;
  readonly extensions?: Record<string, unknown>;
}

function makeNode(spec: NodeSpec): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: spec.id,
    type: spec.type,
    revision: spec.revision ?? 1,
    status: spec.status ?? "accepted",
    source: "workflow",
    provenance: { iteration_id: "iteration_01", actor: "audit-test", timestamp: FIXED_NOW },
    confidence: 1,
  };
  if (spec.locator !== undefined) record.locator = spec.locator;
  if (spec.extensions !== undefined) record.extensions = spec.extensions;
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

interface EdgeSpec {
  readonly id: string;
  readonly type: EdgeRecord["type"];
  readonly sourceId: string;
  readonly targetId: string;
  readonly status?: EdgeRecord["status"];
}

function makeEdge(spec: EdgeSpec): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "edge",
    id: spec.id,
    type: spec.type,
    source_id: spec.sourceId,
    target_id: spec.targetId,
    status: spec.status ?? "accepted",
    source: "workflow",
    provenance: { iteration_id: "iteration_01", actor: "audit-test", timestamp: FIXED_NOW },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

/** Fully traced graph: no audit check should fire on it. */
function healthyGraph(): AuditGraph {
  return {
    nodes: [
      makeNode({ id: "intent_01", type: "Intent" }),
      makeNode({ id: "requirement_01", type: "Requirement" }),
      makeNode({ id: "task_01", type: "Task" }),
      makeNode({ id: "test_01", type: "Test" }),
      makeNode({ id: "evidence_01", type: "Evidence" }),
      makeNode({ id: "evaluation-case_01", type: "EvaluationCase" }),
    ],
    edges: [
      makeEdge({
        id: "edge-intent-decomposes_01",
        type: "DECOMPOSES_TO",
        sourceId: "intent_01",
        targetId: "requirement_01",
      }),
      makeEdge({
        id: "edge-task-implements_01",
        type: "IMPLEMENTS",
        sourceId: "task_01",
        targetId: "requirement_01",
      }),
      makeEdge({
        id: "edge-test-verifies_01",
        type: "VERIFIES",
        sourceId: "test_01",
        targetId: "requirement_01",
      }),
      makeEdge({
        id: "edge-evidence-supports_01",
        type: "SUPPORTS",
        sourceId: "evidence_01",
        targetId: "test_01",
      }),
      makeEdge({
        id: "edge-case-evaluates_01",
        type: "EVALUATES",
        sourceId: "evaluation-case_01",
        targetId: "task_01",
      }),
    ],
  };
}

describe("auditGraph", () => {
  it("reports no findings on a fully traced graph", () => {
    const report = auditGraph(healthyGraph());
    expect(report.findings).toEqual([]);
    expect(report.checked_nodes).toBe(6);
    expect(report.checked_edges).toBe(5);
  });

  it("flags an accepted requirement with a traceability gap as blocking", () => {
    const graph = healthyGraph();
    const report = auditGraph({
      nodes: graph.nodes,
      edges: graph.edges.filter((edge) => edge.id !== "edge-task-implements_01"),
    });
    const finding = report.findings.find((entry) => entry.kind === "traceability_gap");
    expect(finding).toBeDefined();
    expect(finding?.subjects).toEqual(["requirement_01"]);
    expect(finding?.blocking).toBe(true);
    expect(finding?.summary).toContain("no Task IMPLEMENTS it");
  });

  it("flags active edges that still reference a superseded node", () => {
    const graph = healthyGraph();
    const report = auditGraph({
      nodes: [
        ...graph.nodes,
        makeNode({ id: "decision_old", type: "Decision", status: "superseded" }),
      ],
      edges: [
        ...graph.edges,
        makeEdge({
          id: "edge-decision-addresses_01",
          type: "ADDRESSES",
          sourceId: "decision_old",
          targetId: "requirement_01",
        }),
      ],
    });
    const finding = report.findings.find((entry) => entry.kind === "stale_knowledge");
    expect(finding).toBeDefined();
    expect(finding?.subjects).toEqual(["decision_old", "edge-decision-addresses_01"]);
  });

  it("flags two accepted constraints stating the same rule as separate authorities", () => {
    const report = auditGraph({
      nodes: [
        makeNode({
          id: "constraint_01",
          type: "Constraint",
          extensions: { "harness.requirements": { statement: "No secrets in logs" } },
        }),
        makeNode({
          id: "constraint_02",
          type: "Constraint",
          extensions: { "harness.requirements": { statement: "  no secrets in logs " } },
        }),
      ],
      edges: [],
    });
    const finding = report.findings.find((entry) => entry.kind === "contradictory_constraint");
    expect(finding).toBeDefined();
    expect(finding?.subjects).toEqual(["constraint_01", "constraint_02"]);
    expect(finding?.blocking).toBe(true);
  });

  it("flags orphan artifact nodes with no active relations", () => {
    const report = auditGraph({
      nodes: [makeNode({ id: "decision_01", type: "Decision" })],
      edges: [],
    });
    const finding = report.findings.find((entry) => entry.kind === "orphan_node");
    expect(finding).toBeDefined();
    expect(finding?.subjects).toEqual(["decision_01"]);
  });

  it("flags an accepted test without any evidence verdict", () => {
    const graph = healthyGraph();
    const report = auditGraph({
      nodes: graph.nodes,
      edges: graph.edges.filter((edge) => edge.id !== "edge-evidence-supports_01"),
    });
    const finding = report.findings.find((entry) => entry.kind === "missing_verification");
    expect(finding).toBeDefined();
    expect(finding?.subjects).toEqual(["test_01"]);
    expect(finding?.blocking).toBe(true);
  });

  it("flags unpromoted improvement candidates targeting high-risk layers", () => {
    const report = auditGraph({
      nodes: [
        makeNode({
          id: "improvement_01",
          type: "ImprovementCandidate",
          status: "proposed",
          extensions: { "harness.improvement": { target_layer: "policy" } },
        }),
        makeNode({
          id: "improvement_02",
          type: "ImprovementCandidate",
          status: "proposed",
          extensions: { "harness.improvement": { target_layer: "test" } },
        }),
      ],
      edges: [],
    });
    const findings = report.findings.filter(
      (entry) => entry.kind === "unpromoted_high_risk_improvement",
    );
    expect(findings.map((finding) => finding.subjects)).toEqual([["improvement_01"]]);
  });

  it("flags a run that consumed a superseded context bundle", () => {
    const report = auditGraph({
      nodes: [
        makeNode({ id: "run_01", type: "Run" }),
        makeNode({ id: "context_01", type: "ContextBundle", status: "superseded" }),
      ],
      edges: [
        makeEdge({
          id: "edge-run-uses-context_01",
          type: "USES_CONTEXT",
          sourceId: "run_01",
          targetId: "context_01",
        }),
      ],
    });
    const finding = report.findings.find((entry) => entry.kind === "unhealthy_context_source");
    expect(finding).toBeDefined();
    expect(finding?.subjects).toEqual(["context_01", "run_01"]);
    expect(finding?.blocking).toBe(true);
  });

  it("ignores rejected and superseded edges", () => {
    const graph = healthyGraph();
    const report = auditGraph({
      nodes: graph.nodes,
      edges: graph.edges.map((edge) =>
        edge.id === "edge-task-implements_01" ? { ...edge, status: "superseded" as const } : edge,
      ),
    });
    // The superseded IMPLEMENTS edge no longer counts, so the gap reappears.
    expect(report.findings.some((entry) => entry.kind === "traceability_gap")).toBe(true);
    // But the superseded edge itself is never reported as stale knowledge.
    expect(report.findings.filter((entry) => entry.kind === "stale_knowledge")).toEqual([]);
  });

  it("is deterministic: identical input produces identical findings", () => {
    const graph = healthyGraph();
    expect(auditGraph(graph)).toEqual(auditGraph(graph));
  });

  describe("missing_design_artifact", () => {
    const plannedNode = makeNode({ id: "plan_01", type: "ExecutionPlan", status: "proposed" });

    function designFindings(graph: AuditGraph) {
      return auditGraph(graph).findings.filter((entry) => entry.kind === "missing_design_artifact");
    }

    it("stays silent without an execution plan, even on a traced graph", () => {
      // The healthy graph carries a Task but no plan: a fresh project must
      // never be nagged about design documents it has not planned yet.
      expect(designFindings(healthyGraph())).toEqual([]);
    });

    it("flags every uncovered domain once an execution plan exists", () => {
      const findings = designFindings({ nodes: [plannedNode], edges: [] });
      expect(findings.map((finding) => finding.summary)).toEqual([
        expect.stringContaining("domain: design"),
        expect.stringContaining("domain: api-contract"),
        expect.stringContaining("domain: data-design"),
        expect.stringContaining("domain: decision"),
      ]);
      for (const finding of findings) {
        expect(finding.blocking).toBe(false);
        expect(finding.subjects).toEqual([]);
      }
    });

    it("accepts keyword-matching documentation and Decision nodes as coverage", () => {
      const findings = designFindings({
        nodes: [
          plannedNode,
          makeNode({
            id: "doc_design",
            type: "CodeArtifact",
            locator: "repo://repo_01/docs/design.md",
          }),
          makeNode({
            id: "doc_api",
            type: "CodeArtifact",
            locator: "repo://repo_01/docs/api-contract.md",
            extensions: { "harness.scan": { classification: "documentation" } },
          }),
          makeNode({
            id: "doc_data",
            type: "CodeArtifact",
            status: "proposed",
            locator: "repo://repo_01/docs/data-design.md",
          }),
          makeNode({ id: "decision_01", type: "Decision" }),
        ],
        edges: [],
      });
      // The proposed data design doc does not count; only it remains flagged.
      expect(findings.map((finding) => finding.summary)).toEqual([
        expect.stringContaining("domain: data-design"),
      ]);
    });

    it("requires a frontend design doc only when the graph shows a frontend signal", () => {
      const backendOnly = designFindings({ nodes: [plannedNode], edges: [] });
      expect(
        backendOnly.some((finding) => finding.summary.includes("domain: frontend-design")),
      ).toBe(false);
      const withFrontend = designFindings({
        nodes: [
          plannedNode,
          makeNode({ id: "code_app", type: "CodeArtifact", locator: "repo://repo_01/src/App.tsx" }),
        ],
        edges: [],
      });
      expect(
        withFrontend.some((finding) => finding.summary.includes("domain: frontend-design")),
      ).toBe(true);
    });

    it("does not treat a guide as a frontend (ui) document", () => {
      const findings = designFindings({
        nodes: [
          plannedNode,
          makeNode({ id: "code_app", type: "CodeArtifact", locator: "repo://repo_01/src/App.tsx" }),
          makeNode({
            id: "doc_guide",
            type: "CodeArtifact",
            locator: "repo://repo_01/docs/guide.md",
          }),
        ],
        edges: [],
      });
      expect(findings.some((finding) => finding.summary.includes("domain: frontend-design"))).toBe(
        true,
      );
    });
  });

  describe("task_orphan", () => {
    it("flags a task that implements no requirement as blocking", () => {
      const report = auditGraph({
        nodes: [makeNode({ id: "task_01", type: "Task" })],
        edges: [],
      });
      const finding = report.findings.find((entry) => entry.kind === "task_orphan");
      expect(finding).toBeDefined();
      expect(finding?.subjects).toEqual(["task_01"]);
      expect(finding?.blocking).toBe(true);
    });

    it("does not fire when the gap is Requirement-side only", () => {
      const report = auditGraph({
        nodes: [makeNode({ id: "requirement_01", type: "Requirement" })],
        edges: [],
      });
      expect(report.findings.some((entry) => entry.kind === "traceability_gap")).toBe(true);
      expect(report.findings.some((entry) => entry.kind === "task_orphan")).toBe(false);
    });

    it("stays silent for a wired task", () => {
      const report = auditGraph(healthyGraph());
      expect(report.findings.some((entry) => entry.kind === "task_orphan")).toBe(false);
    });
  });

  describe("api_contract_coverage", () => {
    const plannedNode = makeNode({ id: "plan_01", type: "ExecutionPlan", status: "proposed" });
    const contractNode = makeNode({
      id: "doc_contract",
      type: "CodeArtifact",
      locator: "repo://repo_01/docs/api-contract.md",
      extensions: {
        "harness.scan": {
          classification: "documentation",
          api_entries: ["DELETE /sessions", "GET /sessions", "POST /sessions"],
        },
      },
    });

    function taskWithObjective(id: string, objective: string): NodeRecord {
      return makeNode({
        id,
        type: "Task",
        extensions: { "harness.plan": { id, objective, expected_outputs: [] } },
      });
    }

    it("flags uncovered contract entries as warnings, one per entry", () => {
      const report = auditGraph({
        nodes: [
          plannedNode,
          contractNode,
          taskWithObjective("task_01", "implement GET /sessions"),
          taskWithObjective("task_02", "implement POST /sessions"),
        ],
        edges: [],
      });
      const findings = report.findings.filter((entry) => entry.kind === "api_contract_coverage");
      expect(findings).toHaveLength(1);
      expect(findings[0]?.summary).toContain("DELETE /sessions");
      expect(findings[0]?.subjects).toEqual(["doc_contract"]);
      expect(findings[0]?.blocking).toBe(false);
    });

    it("stays silent when no contract document exists", () => {
      const report = auditGraph({ nodes: [plannedNode], edges: [] });
      expect(report.findings.some((entry) => entry.kind === "api_contract_coverage")).toBe(false);
      // The existence check belongs to missing_design_artifact alone.
      expect(report.findings.some((entry) => entry.kind === "missing_design_artifact")).toBe(true);
    });

    it("stays silent for contract documents without extracted entries", () => {
      const report = auditGraph({
        nodes: [
          plannedNode,
          makeNode({
            id: "doc_legacy",
            type: "CodeArtifact",
            locator: "repo://repo_01/docs/api-contract.md",
            extensions: { "harness.scan": { classification: "documentation" } },
          }),
        ],
        edges: [],
      });
      expect(report.findings.some((entry) => entry.kind === "api_contract_coverage")).toBe(false);
    });
  });

  describe("task_stale", () => {
    it("flags an accepted task with no current verdict as blocking", () => {
      const report = auditGraph({
        nodes: [makeNode({ id: "task_01", type: "Task" })],
        edges: [],
      });
      const finding = report.findings.find((entry) => entry.kind === "task_stale");
      expect(finding).toBeDefined();
      expect(finding?.subjects).toEqual(["task_01"]);
      expect(finding?.blocking).toBe(true);
    });

    it("stays silent for a task with a fresh quality record (audit context)", () => {
      const graph = { nodes: [makeNode({ id: "task_01", type: "Task" })], edges: [] };
      expect(auditGraph(graph).findings.some((entry) => entry.kind === "task_stale")).toBe(true);
      expect(
        auditGraph(graph, { provenTaskIds: ["task_01"] }).findings.some(
          (entry) => entry.kind === "task_stale",
        ),
      ).toBe(false);
    });

    it("stays silent for a proposed task or an evaluated one", () => {
      const report = auditGraph({
        nodes: [
          makeNode({ id: "task_01", type: "Task", status: "proposed" }),
          makeNode({ id: "task_02", type: "Task" }),
          makeNode({ id: "evaluation-case_01", type: "EvaluationCase" }),
        ],
        edges: [
          makeEdge({
            id: "edge-case-evaluates_01",
            type: "EVALUATES",
            sourceId: "evaluation-case_01",
            targetId: "task_02",
          }),
        ],
      });
      expect(report.findings.some((entry) => entry.kind === "task_stale")).toBe(false);
    });

    it("never shares a subject with missing_verification", () => {
      const report = auditGraph({
        nodes: [
          makeNode({ id: "task_01", type: "Task" }),
          makeNode({ id: "test_01", type: "Test" }),
        ],
        edges: [],
      });
      const stale = report.findings.find((entry) => entry.kind === "task_stale");
      const missing = report.findings.find((entry) => entry.kind === "missing_verification");
      expect(stale?.subjects).toEqual(["task_01"]);
      expect(missing?.subjects).toEqual(["test_01"]);
      expect(report.findings.filter((entry) => entry.kind === "missing_verification")).toHaveLength(
        1,
      );
    });
  });
});
