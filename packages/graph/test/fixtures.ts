import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LedgerRepository,
  canonicalizeJson,
  contentDigest,
  type EdgeRecord,
  type LifecycleEvent,
  type NodeRecord,
  type TransactionInput,
} from "@universal-harness-internal/core";

/**
 * Deterministic ledger scenario shared by the materializer and graph-view
 * tests: one baseline operation with artifact knowledge, one operation adding
 * execution nodes and a requirement revision, and one accepting a proposed
 * inferred edge. Fixed timestamps and content-derived digests keep every
 * projection byte-identical across runs and platforms.
 */
export const FIXED_NOW = "2026-08-12T00:00:00.000Z";
export const BASELINE = "0123456789abcdef";

export function makeProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), "harness-graph-"));
}

interface NodeSpec {
  readonly id: string;
  readonly type: NodeRecord["type"];
  readonly revision?: number;
  readonly status?: NodeRecord["status"];
  readonly source?: NodeRecord["source"];
  readonly confidence?: number;
  readonly locator?: string;
  readonly iterationState?: NodeRecord["iteration_state"];
  readonly extensions?: Record<string, unknown>;
}

export function makeNode(spec: NodeSpec): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: spec.id,
    type: spec.type,
    revision: spec.revision ?? 1,
    status: spec.status ?? "accepted",
    source: spec.source ?? "workflow",
    provenance: { iteration_id: "iteration_01", actor: "graph-test", timestamp: FIXED_NOW },
    confidence: spec.confidence ?? 1,
  };
  if (spec.locator !== undefined) record.locator = spec.locator;
  if (spec.iterationState !== undefined) record.iteration_state = spec.iterationState;
  if (spec.extensions !== undefined) record.extensions = spec.extensions;
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

interface EdgeSpec {
  readonly id: string;
  readonly type: EdgeRecord["type"];
  readonly sourceId: string;
  readonly targetId: string;
  readonly status?: EdgeRecord["status"];
  readonly source?: EdgeRecord["source"];
  readonly confidence?: number;
}

export function makeEdge(spec: EdgeSpec): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "edge",
    id: spec.id,
    type: spec.type,
    source_id: spec.sourceId,
    target_id: spec.targetId,
    status: spec.status ?? "accepted",
    source: spec.source ?? "workflow",
    provenance: { iteration_id: "iteration_01", actor: "graph-test", timestamp: FIXED_NOW },
    confidence: spec.confidence ?? 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

export function makeEvent(
  eventId: string,
  eventType: LifecycleEvent["event_type"],
  ledgerOperationId: string,
): LifecycleEvent {
  return {
    protocol_version: "1.0.0",
    record_kind: "event",
    event_id: eventId,
    event_type: eventType,
    project_id: "project_01",
    iteration_id: "iteration_01",
    workflow_operation_id: "workflow-op_01",
    ledger_operation_id: ledgerOperationId,
    sequence: 1,
    timestamp: FIXED_NOW,
    payload: {},
  } as LifecycleEvent;
}

function artifact(path: string, node: NodeRecord): { path: string; content: string } {
  return { path, content: `${canonicalizeJson(node)}\n` };
}

export const SCENARIO_NODES = {
  project: makeNode({ id: "project_01", type: "Project" }),
  repository: makeNode({ id: "repository_01", type: "Repository" }),
  intent: makeNode({ id: "intent_01", type: "Intent" }),
  requirementV1: makeNode({ id: "requirement_01", type: "Requirement", revision: 1 }),
  requirementV2: makeNode({
    id: "requirement_01",
    type: "Requirement",
    revision: 2,
    extensions: { "acme.note": "revised" },
  }),
  decision: makeNode({ id: "decision_01", type: "Decision" }),
  component: makeNode({ id: "component_01", type: "Component" }),
  codeArtifact: makeNode({
    id: "code_01",
    type: "CodeArtifact",
    source: "scanner",
    locator: "repo://repository_01/src/widget.ts",
  }),
  test: makeNode({ id: "test_01", type: "Test" }),
  iteration: makeNode({
    id: "iteration_01",
    type: "Iteration",
    iterationState: "running",
  }),
  plan: makeNode({ id: "plan_01", type: "ExecutionPlan" }),
  task: makeNode({ id: "task_01", type: "Task" }),
  contextBundle: makeNode({ id: "context_01", type: "ContextBundle" }),
  run: makeNode({ id: "run_01", type: "Run" }),
  evidence: makeNode({ id: "evidence_01", type: "Evidence", source: "gate" }),
  approvalRequest: makeNode({ id: "approval-request_01", type: "ApprovalRequest" }),
  approval: makeNode({ id: "approval_01", type: "Approval" }),
} as const;

export const PROPOSED_EDGE_ID = "edge-evidence-supports-requirement_01";

function scenarioEdges(): {
  readonly baseline: EdgeRecord[];
  readonly execution: EdgeRecord[];
  readonly acceptance: EdgeRecord[];
} {
  const baseline: EdgeRecord[] = [
    makeEdge({
      id: "edge-project-contains-intent_01",
      type: "CONTAINS",
      sourceId: "project_01",
      targetId: "intent_01",
    }),
    makeEdge({
      id: "edge-project-contains-repository_01",
      type: "CONTAINS",
      sourceId: "project_01",
      targetId: "repository_01",
    }),
    makeEdge({
      id: "edge-project-contains-iteration_01",
      type: "CONTAINS",
      sourceId: "project_01",
      targetId: "iteration_01",
    }),
    makeEdge({
      id: "edge-intent-decomposes-requirement_01",
      type: "DECOMPOSES_TO",
      sourceId: "intent_01",
      targetId: "requirement_01",
    }),
    makeEdge({
      id: "edge-decision-addresses-requirement_01",
      type: "ADDRESSES",
      sourceId: "decision_01",
      targetId: "requirement_01",
    }),
    makeEdge({
      id: "edge-decision-shapes-component_01",
      type: "SHAPES",
      sourceId: "decision_01",
      targetId: "component_01",
    }),
    makeEdge({
      id: "edge-code-realizes-component_01",
      type: "REALIZES",
      sourceId: "code_01",
      targetId: "component_01",
    }),
    makeEdge({
      id: "edge-test-verifies-requirement_01",
      type: "VERIFIES",
      sourceId: "test_01",
      targetId: "requirement_01",
    }),
  ];
  const execution: EdgeRecord[] = [
    makeEdge({
      id: "edge-iteration-contains-plan_01",
      type: "CONTAINS",
      sourceId: "iteration_01",
      targetId: "plan_01",
    }),
    makeEdge({
      id: "edge-plan-contains-task_01",
      type: "CONTAINS",
      sourceId: "plan_01",
      targetId: "task_01",
    }),
    makeEdge({
      id: "edge-task-implements-requirement_01",
      type: "IMPLEMENTS",
      sourceId: "task_01",
      targetId: "requirement_01",
    }),
    makeEdge({
      id: "edge-run-executes-task_01",
      type: "EXECUTES",
      sourceId: "run_01",
      targetId: "task_01",
    }),
    makeEdge({
      id: "edge-run-uses-context_01",
      type: "USES_CONTEXT",
      sourceId: "run_01",
      targetId: "context_01",
    }),
    makeEdge({
      id: "edge-run-produces-evidence_01",
      type: "PRODUCES",
      sourceId: "run_01",
      targetId: "evidence_01",
    }),
    makeEdge({
      id: "edge-evidence-supports-test_01",
      type: "SUPPORTS",
      sourceId: "evidence_01",
      targetId: "test_01",
      source: "gate",
    }),
    // Agent-inferred edge: proposed with its original confidence.
    makeEdge({
      id: PROPOSED_EDGE_ID,
      type: "SUPPORTS",
      sourceId: "evidence_01",
      targetId: "requirement_01",
      status: "proposed",
      source: "agent",
      confidence: 0.6,
    }),
    makeEdge({
      id: "edge-approval-request-targets-plan_01",
      type: "REQUESTS_APPROVAL_FOR",
      sourceId: "approval-request_01",
      targetId: "plan_01",
    }),
    makeEdge({
      id: "edge-approval-resolves-request_01",
      type: "RESOLVES",
      sourceId: "approval_01",
      targetId: "approval-request_01",
    }),
    makeEdge({
      id: "edge-approval-approves-plan_01",
      type: "APPROVES",
      sourceId: "approval_01",
      targetId: "plan_01",
    }),
  ];
  // Acceptance keeps the original confidence; only the status changes.
  const proposed = execution.find((edge) => edge.id === PROPOSED_EDGE_ID) as EdgeRecord;
  const acceptance: EdgeRecord[] = [
    makeEdge({
      id: PROPOSED_EDGE_ID,
      type: "SUPPORTS",
      sourceId: "evidence_01",
      targetId: "requirement_01",
      status: "accepted",
      source: "agent",
      confidence: proposed.confidence,
    }),
  ];
  return { baseline, execution, acceptance };
}

export function scenarioInputs(): TransactionInput[] {
  const nodes = SCENARIO_NODES;
  const edges = scenarioEdges();
  return [
    {
      ledger_operation_id: "ledger-op_01",
      workflow_operation_id: "workflow-op_01",
      attempt_id: "attempt_01",
      expected_baseline: BASELINE,
      artifacts: [
        artifact("artifacts/projects/project_01.json", nodes.project),
        artifact("artifacts/repositories/repository_01.json", nodes.repository),
        artifact("artifacts/intents/intent_01.json", nodes.intent),
        artifact("artifacts/requirements/requirement_01.json", nodes.requirementV1),
        artifact("artifacts/decisions/decision_01.json", nodes.decision),
        artifact("artifacts/components/component_01.json", nodes.component),
        artifact("artifacts/code-artifacts/code_01.json", nodes.codeArtifact),
        artifact("artifacts/tests/test_01.json", nodes.test),
        artifact("artifacts/iterations/iteration_01.json", nodes.iteration),
      ],
      edges: edges.baseline,
      events: [makeEvent("event-op-01-started_01", "OperationStarted", "ledger-op_01")],
    },
    {
      ledger_operation_id: "ledger-op_02",
      workflow_operation_id: "workflow-op_01",
      attempt_id: "attempt_01",
      expected_baseline: BASELINE,
      artifacts: [
        artifact("artifacts/requirements/requirement_01.r2.json", nodes.requirementV2),
        artifact("artifacts/plans/plan_01.json", nodes.plan),
        artifact("artifacts/tasks/task_01.json", nodes.task),
        artifact("artifacts/contexts/context_01.json", nodes.contextBundle),
        artifact("artifacts/runs/run_01.json", nodes.run),
        artifact("artifacts/evidence/evidence_01.json", nodes.evidence),
        artifact("artifacts/approvals/approval-request_01.json", nodes.approvalRequest),
        artifact("artifacts/approvals/approval_01.json", nodes.approval),
      ],
      edges: edges.execution,
      events: [makeEvent("event-op-02-plan-accepted_01", "PlanAccepted", "ledger-op_02")],
    },
    {
      ledger_operation_id: "ledger-op_03",
      workflow_operation_id: "workflow-op_01",
      attempt_id: "attempt_01",
      expected_baseline: BASELINE,
      edges: edges.acceptance,
      events: [makeEvent("event-op-03-gate-completed_01", "GateCompleted", "ledger-op_03")],
    },
  ];
}

export function makeRepository(projectRoot: string): LedgerRepository {
  return new LedgerRepository({
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
  });
}

/** Commit the full three-operation scenario into a fresh project root. */
export async function commitScenario(projectRoot: string): Promise<void> {
  const repository = makeRepository(projectRoot);
  for (const input of scenarioInputs()) {
    await repository.commit(input);
  }
}
