import { describe, expect, it } from "vitest";

import { contentDigest, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";

import { createNewProject } from "../../src/bootstrap/new-project.js";
import { collectProjectStatus, deriveProjectStatus } from "../../src/status/status.js";
import { cleanupDirectories, makeDeps, makeTempDir } from "../bootstrap/helpers.js";

const FIXED_NOW = "2026-08-12T00:00:00.000Z";

interface NodeSpec {
  readonly id: string;
  readonly type: NodeRecord["type"];
  readonly status?: NodeRecord["status"];
  readonly iterationState?: NodeRecord["iteration_state"];
  readonly timestamp?: string;
  readonly extensions?: Record<string, unknown>;
}

function makeNode(spec: NodeSpec): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: spec.id,
    type: spec.type,
    revision: 1,
    status: spec.status ?? "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "status-test",
      timestamp: spec.timestamp ?? FIXED_NOW,
    },
    confidence: 1,
  };
  if (spec.iterationState !== undefined) record.iteration_state = spec.iterationState;
  if (spec.extensions !== undefined) record.extensions = spec.extensions;
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

interface EdgeSpec {
  readonly id: string;
  readonly type: EdgeRecord["type"];
  readonly sourceId: string;
  readonly targetId: string;
}

function makeEdge(spec: EdgeSpec): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "edge",
    id: spec.id,
    type: spec.type,
    source_id: spec.sourceId,
    target_id: spec.targetId,
    status: "accepted",
    source: "workflow",
    provenance: { iteration_id: "iteration_01", actor: "status-test", timestamp: FIXED_NOW },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

describe("deriveProjectStatus", () => {
  it("asks for an intent when the graph has no iteration", () => {
    const status = deriveProjectStatus({ nodes: [], edges: [] });
    expect(status.iteration).toBeUndefined();
    expect(status.next_action).toContain("harness new");
    expect(status.blockers).toEqual([]);
    expect(status.pending_approvals).toEqual([]);
  });

  it("surfaces the open iteration and its recorded next action", () => {
    const status = deriveProjectStatus({
      nodes: [makeNode({ id: "iteration_01", type: "Iteration", iterationState: "running" })],
      edges: [],
      workingState: {
        blockers: [],
        budget: { used_steps: 2, used_tokens: 100, ceiling_steps: 10, ceiling_tokens: 1000 },
        next_action: "run the perf gate",
      },
    });
    expect(status.iteration).toEqual({ id: "iteration_01", state: "running" });
    expect(status.next_action).toBe("run the perf gate");
    expect(status.budget?.used_steps).toBe(2);
  });

  it("prefers a completed iteration's follow-up over an open one", () => {
    const status = deriveProjectStatus({
      nodes: [
        makeNode({ id: "iteration_01", type: "Iteration", iterationState: "completed" }),
        makeNode({ id: "iteration_02", type: "Iteration", iterationState: "draft" }),
      ],
      edges: [],
    });
    expect(status.iteration).toEqual({ id: "iteration_02", state: "draft" });
    expect(status.next_action).toContain("run iteration iteration_02");
  });

  it("tracks the chronologically latest iteration, not the id-sorted one", () => {
    // Content-derived iteration ids have no chronological order: iteration_zz
    // committed before iteration_aa, and status must follow the ledger time.
    const status = deriveProjectStatus({
      nodes: [
        makeNode({
          id: "iteration_zz",
          type: "Iteration",
          iterationState: "completed",
          timestamp: "2026-08-12T00:00:00.000Z",
        }),
        makeNode({
          id: "iteration_aa",
          type: "Iteration",
          iterationState: "completed",
          timestamp: "2026-08-13T00:00:00.000Z",
        }),
      ],
      edges: [],
    });
    expect(status.iteration?.id).toBe("iteration_aa");
  });

  it("still prefers an open iteration over a chronologically newer completed one", () => {
    const status = deriveProjectStatus({
      nodes: [
        makeNode({
          id: "iteration_01",
          type: "Iteration",
          iterationState: "draft",
          timestamp: "2026-08-12T00:00:00.000Z",
        }),
        makeNode({
          id: "iteration_02",
          type: "Iteration",
          iterationState: "completed",
          timestamp: "2026-08-13T00:00:00.000Z",
        }),
      ],
      edges: [],
    });
    expect(status.iteration?.id).toBe("iteration_01");
  });

  it("lists unresolved approval requests and routes the next action to them", () => {
    const status = deriveProjectStatus({
      nodes: [
        makeNode({ id: "iteration_01", type: "Iteration", iterationState: "running" }),
        makeNode({ id: "approval-request_01", type: "ApprovalRequest", status: "proposed" }),
        makeNode({ id: "approval-request_02", type: "ApprovalRequest", status: "proposed" }),
        makeNode({ id: "approval_01", type: "Approval" }),
      ],
      edges: [
        makeEdge({
          id: "edge-approval-resolves_01",
          type: "RESOLVES",
          sourceId: "approval_01",
          targetId: "approval-request_02",
        }),
      ],
    });
    expect(status.pending_approvals).toEqual(["approval-request_01"]);
    expect(status.next_action).toBe("resolve approval request approval-request_01");
  });

  it("derives blockers from open findings that block the iteration", () => {
    const status = deriveProjectStatus({
      nodes: [
        makeNode({ id: "iteration_01", type: "Iteration", iterationState: "running" }),
        makeNode({ id: "finding_01", type: "Finding", status: "accepted" }),
        makeNode({ id: "finding_02", type: "Finding", status: "tombstoned" }),
      ],
      edges: [
        makeEdge({
          id: "edge-finding-blocks_01",
          type: "BLOCKS",
          sourceId: "finding_01",
          targetId: "iteration_01",
        }),
        makeEdge({
          id: "edge-finding-blocks_02",
          type: "BLOCKS",
          sourceId: "finding_02",
          targetId: "iteration_01",
        }),
      ],
      workingState: {
        blockers: ["waiting on the user"],
        budget: { used_steps: 0, used_tokens: 0, ceiling_steps: 1, ceiling_tokens: 1 },
      },
    });
    expect(status.blockers).toEqual(["blocking finding finding_01", "waiting on the user"]);
    expect(status.next_action).toBe("repair blocker: blocking finding finding_01");
  });

  it("suppresses a historical run-failure blocker once its task is accepted", () => {
    const status = deriveProjectStatus({
      nodes: [
        makeNode({ id: "iteration_01", type: "Iteration", iterationState: "completed" }),
        makeNode({ id: "task_01", type: "Task", status: "accepted" }),
      ],
      edges: [],
      workingState: {
        blockers: ["task task_01 did not complete: provider credential is missing"],
        budget: { used_steps: 0, used_tokens: 0, ceiling_steps: 1, ceiling_tokens: 1 },
      },
    });

    expect(status.blockers).toEqual([]);
  });

  it("demotes explicitly non-blocking findings to warnings", () => {
    const status = deriveProjectStatus({
      nodes: [
        makeNode({ id: "iteration_01", type: "Iteration", iterationState: "running" }),
        makeNode({ id: "finding_01", type: "Finding", status: "accepted" }),
        makeNode({
          id: "finding_02",
          type: "Finding",
          status: "proposed",
          extensions: {
            "harness.finding": { origin: "audit", blocking: false, blocks: ["iteration_01"] },
          },
        }),
      ],
      edges: [
        makeEdge({
          id: "edge-finding-blocks_01",
          type: "BLOCKS",
          sourceId: "finding_01",
          targetId: "iteration_01",
        }),
        makeEdge({
          id: "edge-finding-blocks_02",
          type: "BLOCKS",
          sourceId: "finding_02",
          targetId: "iteration_01",
        }),
      ],
    });
    expect(status.blockers).toEqual(["blocking finding finding_01"]);
    expect(status.warnings).toEqual(["warning finding finding_02"]);
    expect(status.next_action).toBe("repair blocker: blocking finding finding_01");
  });

  it("projects Atlas-scale Findings into stable groups while preserving legacy arrays", () => {
    const staleFindings = Array.from({ length: 52 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      return makeNode({
        id: `finding_stale-${suffix}`,
        type: "Finding",
        status: "proposed",
        extensions: {
          "harness.finding": {
            origin: "audit",
            blocking: false,
            blocks: [],
            rule: "audit/stale_knowledge",
            scope_prefix: "project/repository_atlas/knowledge",
            severity: "warning",
            actionability: "auto_close",
            subject_ids: [`node_${suffix}`],
            subject_digests: [],
          },
        },
      });
    });
    const designFinding = makeNode({
      id: "finding_design-01",
      type: "Finding",
      status: "proposed",
      extensions: {
        "harness.finding": {
          origin: "audit",
          blocking: false,
          blocks: [],
          rule: "audit/missing_design_artifact",
          scope_prefix: "project/repository_atlas/design",
          severity: "warning",
          actionability: "auto_close",
          subject_ids: ["design"],
          subject_digests: [],
        },
      },
    });

    const status = deriveProjectStatus({ nodes: [...staleFindings, designFinding], edges: [] });

    expect(status.warnings).toHaveLength(53);
    expect(status.finding_groups).toHaveLength(2);
    expect(status.finding_groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "audit/stale_knowledge",
          open_count: 52,
          member_count: 52,
          samples: [
            "finding_stale-01",
            "finding_stale-02",
            "finding_stale-03",
            "finding_stale-04",
            "finding_stale-05",
          ],
        }),
        expect.objectContaining({
          rule: "audit/missing_design_artifact",
          open_count: 1,
          samples: ["finding_design-01"],
        }),
      ]),
    );
  });

  it("drops working-state approval blockers once the request is resolved", () => {
    const base = {
      nodes: [
        makeNode({ id: "iteration_01", type: "Iteration", iterationState: "completed" }),
        makeNode({ id: "approval-request_01", type: "ApprovalRequest", status: "proposed" }),
        makeNode({ id: "approval-request_02", type: "ApprovalRequest", status: "proposed" }),
        makeNode({ id: "approval_01", type: "Approval" }),
      ],
      workingState: {
        blockers: [
          "approval request approval-request_01 awaiting a decision",
          "approval request approval-request_02 awaiting a decision",
          "waiting on the user",
        ],
        budget: { used_steps: 0, used_tokens: 0, ceiling_steps: 1, ceiling_tokens: 1 },
      },
    };
    const resolved = deriveProjectStatus({
      ...base,
      edges: [
        makeEdge({
          id: "edge-approval-resolves_01",
          type: "RESOLVES",
          sourceId: "approval_01",
          targetId: "approval-request_01",
        }),
      ],
    });
    expect(resolved.blockers).toEqual([
      "approval request approval-request_02 awaiting a decision",
      "waiting on the user",
    ]);
    expect(resolved.next_action).toBe("resolve approval request approval-request_02");

    // Real ledgers carry resolution in decision artifacts, not RESOLVES edges:
    // the caller supplies resolvedApprovalIds read from the ledger instead.
    const allResolved = deriveProjectStatus({
      ...base,
      edges: [],
      resolvedApprovalIds: ["approval-request_01", "approval-request_02"],
    });
    expect(allResolved.blockers).toEqual(["waiting on the user"]);
    expect(allResolved.next_action).not.toContain("awaiting a decision");
  });

  it("drops the transient recovery blocker once the iteration is terminal", () => {
    const base = {
      nodes: [makeNode({ id: "iteration_01", type: "Iteration", iterationState: "completed" })],
      edges: [],
      workingState: {
        blockers: [
          "recovered from an interrupted process; resuming from the last committed checkpoint",
          "waiting on the user",
        ],
        budget: { used_steps: 0, used_tokens: 0, ceiling_steps: 1, ceiling_tokens: 1 },
      },
    };
    const status = deriveProjectStatus(base);
    // The recovery note is a phantom: the iteration reached a terminal state
    // through gates, audit, and evaluation after the resume completed.
    expect(status.blockers).toEqual(["waiting on the user"]);

    // While the iteration is still live the recovery note stays actionable.
    const live = deriveProjectStatus({
      ...base,
      nodes: [makeNode({ id: "iteration_01", type: "Iteration", iterationState: "blocked" })],
    });
    expect(live.blockers).toContain(
      "recovered from an interrupted process; resuming from the last committed checkpoint",
    );
  });

  it("reports superseded evidence still referenced by verdict edges as stale", () => {
    const status = deriveProjectStatus({
      nodes: [
        makeNode({ id: "iteration_01", type: "Iteration", iterationState: "running" }),
        makeNode({ id: "evidence_01", type: "Evidence", status: "superseded" }),
        makeNode({ id: "test_01", type: "Test" }),
      ],
      edges: [
        makeEdge({
          id: "edge-evidence-supports_01",
          type: "SUPPORTS",
          sourceId: "evidence_01",
          targetId: "test_01",
        }),
      ],
    });
    expect(status.stale_evidence).toEqual(["evidence_01"]);
    expect(status.next_action).toContain("stale evidence evidence_01");
  });

  it("computes evaluation coverage from accepted evaluation cases", () => {
    const status = deriveProjectStatus({
      nodes: [
        makeNode({ id: "run_01", type: "Run" }),
        makeNode({ id: "run_02", type: "Run" }),
        makeNode({ id: "evaluation-case_01", type: "EvaluationCase" }),
      ],
      edges: [
        makeEdge({
          id: "edge-evaluates_01",
          type: "EVALUATES",
          sourceId: "evaluation-case_01",
          targetId: "run_01",
        }),
      ],
    });
    expect(status.evaluation_coverage).toEqual({ evaluated: 1, total: 2 });
  });
});

describe("collectProjectStatus", () => {
  it("assembles identity, ledger, cache and derived facets for a real project", async () => {
    try {
      const parent = makeTempDir("harness-status-");
      const outcome = await createNewProject(
        { parentDirectory: parent, name: "status-demo", intent: "exercise status" },
        makeDeps(),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const status = collectProjectStatus(outcome.value.projectRoot);
      expect(status.name).toBe("status-demo");
      expect(status.project_root).toBe(outcome.value.projectRoot);
      expect(status.repository_id).toBe(outcome.value.repositoryId);
      expect(status.committed_operations).toBeGreaterThanOrEqual(1);
      expect(status.last_ledger_operation).not.toBe("none");
      expect(status.graph_cache).toBe("missing");
      expect(status.control_level).toBe("none");
      expect(status.next_action.length).toBeGreaterThan(0);
    } finally {
      cleanupDirectories();
    }
  });
});
