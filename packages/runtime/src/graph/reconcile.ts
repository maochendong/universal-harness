import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  GRAPH_DATABASE_RELATIVE_PATH,
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
  sha256Hex,
  ulid,
  validateSchema,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  materializeLedger,
  pageEdges,
  pageNodes,
  rebuildGraphCache,
} from "@universal-harness-internal/graph";

import { auditGraph, type AuditFinding } from "../audit/auditor.js";
import { hashWorktreeCode, resolveSnapshotSourceCommit } from "../snapshot/anchor.js";
import type { SnapshotRecord } from "../snapshot/builder.js";

export interface GraphReconcileDependencies {
  readonly projectRoot: string;
  readonly readBaseline: () => string;
  readonly now?: () => string;
}

export interface GraphReconcileResult {
  readonly nodes: number;
  readonly edges: number;
  readonly revisions: number;
  readonly runs_linked: number;
  readonly evaluations: number;
  readonly evidence_links: number;
  readonly findings_created: number;
  readonly findings_superseded: number;
  readonly block_edges_retired: number;
  readonly finding_edges_retired: number;
  readonly skipped: readonly string[];
}

interface RunMetadata {
  readonly runId: string;
  readonly taskId: string;
  readonly iterationId: string;
  readonly timestamp: string;
  readonly terminal: boolean;
  readonly interrupted: boolean;
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(absolute));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(absolute);
  }
  return files;
}

function edgeId(type: EdgeRecord["type"], sourceId: string, targetId: string): string {
  return `edge_${contentDigest({ type, source: sourceId, target: targetId }).slice(0, 16)}`;
}

function auditFindingId(finding: AuditFinding): string {
  const key = sha256Hex(`${finding.kind}\n${finding.summary}`).slice(0, 16);
  return `finding_audit-${finding.kind.replaceAll("_", "-")}-${key}`;
}

function assertNode(node: Record<string, unknown>): NodeRecord {
  const validation = validateSchema("node", node);
  if (!validation.valid) {
    throw new Error(
      `invalid reconciled node ${String(node["id"])}: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return node as unknown as NodeRecord;
}

function assertEdge(edge: Record<string, unknown>): EdgeRecord {
  const validation = validateSchema("edge", edge);
  if (!validation.valid) {
    throw new Error(
      `invalid reconciled edge ${String(edge["id"])}: ${validation.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return edge as unknown as EdgeRecord;
}

function readRunMetadata(
  harnessRoot: string,
  currentNodes: ReadonlyMap<string, NodeRecord>,
): RunMetadata[] {
  const root = resolveHarnessPath(harnessRoot, "artifacts/runs");
  if (!existsSync(root)) return [];
  const runs: RunMetadata[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (!entry.isDirectory() || currentNodes.get(entry.name)?.type !== "Run") continue;
    const records = filesBelow(join(root, entry.name)).map(
      (path) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
    );
    const started = records.find((record) => record["record_kind"] === "run_started");
    const terminalRecord = records.find(
      (record) =>
        record["record_kind"] === "run_terminated" || record["record_kind"] === "run_interrupted",
    );
    const terminal = terminalRecord !== undefined;
    const interrupted = terminalRecord?.["record_kind"] === "run_interrupted";
    const taskId = started?.["task_id"];
    const timestamp = started?.["timestamp"];
    const iterationId = currentNodes.get(entry.name)?.provenance.iteration_id;
    if (
      typeof taskId !== "string" ||
      typeof timestamp !== "string" ||
      typeof iterationId !== "string"
    ) {
      continue;
    }
    runs.push({ runId: entry.name, taskId, iterationId, timestamp, terminal, interrupted });
  }
  return runs;
}

function completedSnapshotCommits(
  projectRoot: string,
  harnessRoot: string,
): ReadonlyMap<string, readonly string[]> {
  const byIteration = new Map<string, string[]>();
  for (const path of filesBelow(resolveHarnessPath(harnessRoot, "artifacts/snapshots"))) {
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as SnapshotRecord;
    const iterationId = snapshot["iteration_id"];
    const finalCommit = resolveSnapshotSourceCommit(projectRoot, snapshot);
    if (
      snapshot.status !== "completed" ||
      typeof iterationId !== "string" ||
      typeof finalCommit !== "string"
    ) {
      continue;
    }
    byIteration.set(iterationId, [...(byIteration.get(iterationId) ?? []), finalCommit]);
  }
  return byIteration;
}

function worktreeMatchesCommit(projectRoot: string, commit: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["diff", "--quiet", commit, "--", ".", ":(exclude).harness"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: projectRoot,
      encoding: "utf8",
    })
      .split("\0")
      .filter((path) => path !== "" && path !== ".harness" && !path.startsWith(".harness/"));
    return untracked.length === 0;
  } catch {
    return false;
  }
}

/**
 * Append-only repair for historical execution/evaluation/evidence graph gaps.
 * Every certain repair is committed in one ledger operation; uncertain input
 * is reported in `skipped` and never guessed.
 */
export async function reconcileProjectGraph(
  deps: GraphReconcileDependencies,
): Promise<GraphReconcileResult> {
  const now = deps.now?.() ?? new Date().toISOString();
  const harnessRoot = harnessRootFor(deps.projectRoot);
  const operations = readCommittedOperations(harnessRoot);
  const last = operations.at(-1);
  if (last === undefined) throw new Error("cannot reconcile a project without a ledger operation");

  const { database } = materializeLedger({
    projectRoot: deps.projectRoot,
    databasePath: ":memory:",
  });
  const currentNodes = new Map<string, NodeRecord>();
  const activeEdges = new Map<string, EdgeRecord>();
  try {
    let cursor: string | undefined;
    do {
      const page = pageNodes(database, { limit: 500, ...(cursor === undefined ? {} : { cursor }) });
      for (const node of page.items) {
        const current = currentNodes.get(node.id);
        if (current === undefined || node.revision > current.revision)
          currentNodes.set(node.id, node);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    let edgeCursor: string | undefined;
    do {
      const page = pageEdges(database, {
        limit: 500,
        ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
      });
      for (const edge of page.items) {
        if (edge.status === "accepted" || edge.status === "proposed")
          activeEdges.set(edge.id, edge);
        else activeEdges.delete(edge.id);
      }
      edgeCursor = page.nextCursor;
    } while (edgeCursor !== undefined);
  } finally {
    database.close();
  }

  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const committedEdges: EdgeRecord[] = [];
  const skipped = new Set<string>();
  let nodesAdded = 0;
  let edgesAdded = 0;
  let revisions = 0;
  let runsLinked = 0;
  let evaluations = 0;
  let evidenceLinks = 0;
  let findingsCreated = 0;
  let findingsSuperseded = 0;
  let blockEdgesRetired = 0;
  let findingEdgesRetired = 0;

  const appendEdge = (
    type: EdgeRecord["type"],
    sourceId: string,
    targetId: string,
    iterationId: string,
    timestamp: string,
    source: EdgeRecord["source"] = "migration",
  ): boolean => {
    const id = edgeId(type, sourceId, targetId);
    if (activeEdges.has(id)) return false;
    const content: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "edge",
      id,
      type,
      source_id: sourceId,
      target_id: targetId,
      status: "accepted",
      source,
      provenance: { iteration_id: iterationId, actor: "harness-graph-reconcile", timestamp },
      confidence: 1,
    };
    const edge = assertEdge({ ...content, digest: contentDigest(content) });
    committedEdges.push(edge);
    activeEdges.set(id, edge);
    edgesAdded += 1;
    return true;
  };

  const retireActiveFindingEdges = (findingId: string): void => {
    for (const active of [...activeEdges.values()]) {
      if (active.source_id !== findingId && active.target_id !== findingId) continue;
      const retiredContent: Record<string, unknown> = Object.fromEntries(
        Object.entries(active).filter(([key]) => key !== "digest"),
      );
      retiredContent["status"] = "superseded";
      retiredContent["source"] = "migration";
      retiredContent["provenance"] = {
        iteration_id: active.provenance.iteration_id,
        actor: "harness-graph-reconcile",
        timestamp: now,
      };
      committedEdges.push(assertEdge({ ...retiredContent, digest: contentDigest(retiredContent) }));
      activeEdges.delete(active.id);
      if (active.type === "BLOCKS" && active.source_id === findingId) blockEdgesRetired += 1;
      findingEdgesRetired += 1;
      revisions += 1;
    }
  };

  // Historical versions could supersede a Finding without retiring every
  // edge attached to it. Remove that residue before auditing, otherwise the
  // dangling edge itself creates a new stale_knowledge Finding.
  for (const finding of currentNodes.values()) {
    if (
      finding.type === "Finding" &&
      (finding.status === "superseded" || finding.status === "tombstoned")
    ) {
      retireActiveFindingEdges(finding.id);
    }
  }

  const evaluatedRuns = new Set(
    [...activeEdges.values()]
      .filter(
        (edge) =>
          edge.type === "EVALUATES" &&
          currentNodes.get(edge.source_id)?.type === "EvaluationCase" &&
          currentNodes.get(edge.source_id)?.status === "accepted",
      )
      .map((edge) => edge.target_id),
  );
  for (const run of readRunMetadata(harnessRoot, currentNodes)) {
    if (!run.terminal) continue;
    if (currentNodes.get(run.taskId)?.type !== "Task") {
      skipped.add(`${run.runId}: unknown Task ${run.taskId}`);
      continue;
    }
    if (appendEdge("EXECUTES", run.runId, run.taskId, run.iterationId, run.timestamp)) {
      runsLinked += 1;
    }
    if (evaluatedRuns.has(run.runId)) continue;
    const resultPath = resolveHarnessPath(harnessRoot, `artifacts/run-results/${run.runId}.json`);
    let result: Record<string, unknown>;
    if (existsSync(resultPath)) {
      result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    } else if (run.interrupted) {
      // An interrupted Run never wrote a result artifact. Synthesize the
      // deterministic evaluation input view (never a success claim) so the
      // Run still gets its EvaluationCase instead of staying unassessed.
      result = {
        run_id: run.runId,
        task_id: run.taskId,
        completion_claimed: false,
        outcome: "failed",
        termination_reason: "process_interruption",
        interrupted: true,
        summary: "terminal Run interrupted before producing a result artifact",
        state_proposal: null,
        dropped_proposal_fields: [],
        change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
        tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
        usage: {
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          duration_ms: 0,
          metering: "unmetered",
        },
        evidence: [],
        undeclared_writes: [],
      };
    } else {
      skipped.add(`${run.runId}: terminal Run has no result artifact`);
      continue;
    }
    const violations: string[] = [];
    if (result["completion_claimed"] !== true) violations.push("run did not claim completion");
    if (result["outcome"] === "failed") violations.push("run outcome is failed");
    const undeclaredWrites = result["undeclared_writes"];
    if (Array.isArray(undeclaredWrites) && undeclaredWrites.length > 0) {
      violations.push(`undeclared writes: ${undeclaredWrites.map(String).join(", ")}`);
    }
    const passed = violations.length === 0;
    const suffix = run.runId.slice("run_".length);
    const caseId = `case_run_${suffix}`;
    const evidenceId = `evidence_evaluation_run_${suffix}`;
    const extension = {
      case_id: caseId,
      visibility: "external-only",
      checks: ["completion_claim", "containment", "outcome"],
      passed,
    };
    const evidenceContent = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "evidence",
      evidence_id: evidenceId,
      evidence_type: "evaluation_report",
      subject_id: run.taskId,
      digest: contentDigest({
        evidence_type: "evaluation_report",
        subject_id: run.taskId,
        run_id: run.runId,
        extension,
      }),
      provisional: false,
      created_at: run.timestamp,
      extensions: { "harness.evaluation": extension },
    };
    const portResult = {
      evidenceId,
      passed,
      mandatoryFailures: violations,
      findings: [],
      summary: passed ? "terminal Run satisfies the default evaluation" : violations.join("; "),
      record: evidenceContent,
    };
    const evidenceNodeContent: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "node",
      id: evidenceId,
      type: "Evidence",
      revision: 1,
      status: "accepted",
      source: "migration",
      provenance: {
        iteration_id: run.iterationId,
        run_id: run.runId,
        actor: "harness-graph-reconcile",
        timestamp: run.timestamp,
      },
      confidence: 1,
      extensions: {
        "harness.evaluation": {
          evidence_digest: evidenceContent.digest,
          evidence_type: "evaluation_report",
          subject_id: run.taskId,
          provisional: false,
          passed,
        },
      },
    };
    const evidenceNode = assertNode({
      ...evidenceNodeContent,
      digest: contentDigest(evidenceNodeContent),
    });
    const caseNodeContent: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "node",
      id: caseId,
      type: "EvaluationCase",
      revision: 1,
      status: "accepted",
      source: "migration",
      provenance: {
        iteration_id: run.iterationId,
        run_id: run.runId,
        actor: "harness-graph-reconcile",
        timestamp: run.timestamp,
      },
      confidence: 1,
      extensions: {
        "harness.evaluation": {
          evidence_id: evidenceId,
          evidence_digest: evidenceContent.digest,
          subject_id: run.taskId,
          visibility: "external-only",
          passed,
        },
      },
    };
    const caseNode = assertNode({ ...caseNodeContent, digest: contentDigest(caseNodeContent) });
    artifacts.push(
      {
        path: `artifacts/evaluations/${evidenceId}/${evidenceContent.digest}.json`,
        content: `${canonicalizeJson(evidenceContent)}\n`,
      },
      {
        path: `artifacts/evaluate/${run.iterationId}/${sha256Hex(canonicalizeJson(result))}.json`,
        content: `${canonicalizeJson({
          record_kind: "orchestration_evaluate_result",
          iteration_id: run.iterationId,
          run_digest: sha256Hex(canonicalizeJson(result)),
          result: portResult,
        })}\n`,
      },
      {
        path: `artifacts/evaluation-evidence-nodes/${evidenceId}/1.json`,
        content: `${canonicalizeJson(evidenceNode)}\n`,
      },
      {
        path: `artifacts/evaluation-case-nodes/${caseId}/1.json`,
        content: `${canonicalizeJson(caseNode)}\n`,
      },
    );
    currentNodes.set(evidenceId, evidenceNode);
    currentNodes.set(caseId, caseNode);
    nodesAdded += 2;
    appendEdge("PRODUCES", run.runId, evidenceId, run.iterationId, run.timestamp);
    appendEdge("SUPPORTS", evidenceId, caseId, run.iterationId, run.timestamp);
    appendEdge("EVALUATES", caseId, run.taskId, run.iterationId, run.timestamp);
    appendEdge("EVALUATES", caseId, run.runId, run.iterationId, run.timestamp);
    evaluatedRuns.add(run.runId);
    evaluations += 1;
  }

  const currentCodeHash = hashWorktreeCode(deps.projectRoot);
  const snapshots = completedSnapshotCommits(deps.projectRoot, harnessRoot);
  const freshGateEvidence = [...currentNodes.values()].filter((node) => {
    if (node.type !== "Evidence" || node.status !== "accepted" || node.source !== "gate")
      return false;
    const extension = node.extensions?.["harness.evidence"];
    if (typeof extension !== "object" || extension === null) return false;
    const value = extension as Record<string, unknown>;
    if (value["passed"] !== true) return false;
    const bindings = value["bindings"];
    const codeDigests =
      typeof bindings === "object" && bindings !== null
        ? (bindings as Record<string, unknown>)["code_digests"]
        : undefined;
    if (Array.isArray(codeDigests) && codeDigests.includes(currentCodeHash)) return true;
    return (snapshots.get(node.provenance.iteration_id) ?? []).some((commit) =>
      worktreeMatchesCommit(deps.projectRoot, commit),
    );
  });
  const tests = [...currentNodes.values()].filter(
    (node) => node.type === "Test" && node.status === "accepted",
  );
  const testsMissingEvidence = tests.filter(
    (test) =>
      ![...activeEdges.values()].some(
        (edge) =>
          (edge.type === "SUPPORTS" || edge.type === "REFUTES") && edge.target_id === test.id,
      ),
  );
  if (testsMissingEvidence.length > 0 && freshGateEvidence.length === 0) {
    skipped.add(
      `${String(testsMissingEvidence.length)} Test node(s) lack fresh non-provisional Gate Evidence`,
    );
  }
  for (const evidence of freshGateEvidence) {
    const extension = evidence.extensions?.["harness.evidence"] as
      Record<string, unknown> | undefined;
    const gateId = typeof extension?.["gate_id"] === "string" ? extension["gate_id"] : undefined;
    for (const test of tests) {
      const requirementExtension = test.extensions?.["harness.requirements"];
      const verification =
        typeof requirementExtension === "object" && requirementExtension !== null
          ? (requirementExtension as Record<string, unknown>)["verification"]
          : undefined;
      if (typeof verification === "string" && gateId !== undefined) {
        const namesAnyGate = freshGateEvidence.some((candidate) => {
          const candidateExtension = candidate.extensions?.["harness.evidence"] as
            Record<string, unknown> | undefined;
          const candidateGate = candidateExtension?.["gate_id"];
          return typeof candidateGate === "string" && verification.includes(candidateGate);
        });
        if (namesAnyGate && !verification.includes(gateId)) continue;
      }
      if (
        appendEdge(
          "SUPPORTS",
          evidence.id,
          test.id,
          evidence.provenance.iteration_id,
          now,
          "migration",
        )
      ) {
        evidenceLinks += 1;
      }
    }
  }

  const virtualNodes = [...currentNodes.values()].filter((node) => node.status !== "tombstoned");
  const virtualEdges = [...activeEdges.values()];
  const report = auditGraph({ nodes: virtualNodes, edges: virtualEdges });
  const liveFindingIds = new Set(report.findings.map(auditFindingId));
  const latestIteration = virtualNodes
    .filter((node) => node.type === "Iteration")
    .sort((left, right) => left.provenance.timestamp.localeCompare(right.provenance.timestamp))
    .at(-1);
  for (const finding of report.findings) {
    const id = auditFindingId(finding);
    const current = currentNodes.get(id);
    if (current !== undefined && (current.status === "accepted" || current.status === "proposed")) {
      continue;
    }
    if (latestIteration === undefined) {
      skipped.add(`${id}: no Iteration exists for audit provenance`);
      continue;
    }
    const blocks = finding.blocking ? [latestIteration.id] : [];
    const feedbackContent: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "feedback",
      id,
      type: "Finding",
      iteration_id: latestIteration.id,
      status: "proposed",
      summary: finding.summary,
      created_at: now,
      extensions: {
        "harness.finding": {
          origin: "audit",
          blocking: finding.blocking,
          violates: [],
          blocks,
          evidence: [],
        },
        "harness.audit": { kind: finding.kind, subjects: [...finding.subjects] },
      },
    };
    const feedback = { ...feedbackContent, digest: contentDigest(feedbackContent) };
    const feedbackValidation = validateSchema("feedback", feedback);
    if (!feedbackValidation.valid) {
      throw new Error(`invalid reconciled audit feedback ${id}`);
    }
    const nodeContent: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "node",
      id,
      type: "Finding",
      revision: 1,
      status: "proposed",
      source: "audit",
      provenance: {
        iteration_id: latestIteration.id,
        actor: "harness-graph-reconcile",
        timestamp: now,
      },
      confidence: 1,
      extensions: {
        "harness.finding": {
          feedback_digest: feedback.digest,
          origin: "audit",
          blocking: finding.blocking,
          violates: [],
          blocks,
          evidence: [],
        },
        "harness.audit": { kind: finding.kind, subjects: [...finding.subjects] },
      },
    };
    const findingNode = assertNode({ ...nodeContent, digest: contentDigest(nodeContent) });
    artifacts.push(
      {
        path: `artifacts/findings/${id}/proposed.json`,
        content: `${canonicalizeJson(feedback)}\n`,
      },
      {
        path: `artifacts/finding-nodes/${id}/1.json`,
        content: `${canonicalizeJson(findingNode)}\n`,
      },
    );
    currentNodes.set(id, findingNode);
    nodesAdded += 1;
    findingsCreated += 1;
    if (finding.blocking) {
      appendEdge("BLOCKS", id, latestIteration.id, latestIteration.id, now, "audit");
    }
  }

  for (const finding of [...currentNodes.values()]) {
    if (
      finding.type !== "Finding" ||
      finding.source !== "audit" ||
      (finding.status !== "accepted" && finding.status !== "proposed") ||
      liveFindingIds.has(finding.id)
    ) {
      continue;
    }
    const revision = finding.revision + 1;
    const content: Record<string, unknown> = Object.fromEntries(
      Object.entries(finding).filter(([key]) => key !== "digest"),
    );
    content["revision"] = revision;
    content["status"] = "superseded";
    content["source"] = "migration";
    content["provenance"] = {
      iteration_id: finding.provenance.iteration_id,
      actor: "harness-graph-reconcile",
      timestamp: now,
    };
    const superseded = assertNode({ ...content, digest: contentDigest(content) });
    artifacts.push({
      path: `artifacts/finding-nodes/${finding.id}/${String(revision)}.json`,
      content: `${canonicalizeJson(superseded)}\n`,
    });
    currentNodes.set(finding.id, superseded);
    findingsSuperseded += 1;
    revisions += 1;
    retireActiveFindingEdges(finding.id);
  }

  if (artifacts.length > 0 || committedEdges.length > 0) {
    await new LedgerRepository({
      projectRoot: deps.projectRoot,
      readBaseline: deps.readBaseline,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }).commit({
      ledger_operation_id: `ledger_${ulid()}`,
      workflow_operation_id: last.manifest.workflow_operation_id,
      attempt_id: last.manifest.attempt_id,
      expected_baseline: deps.readBaseline(),
      artifacts,
      edges: committedEdges,
      events: [],
    });
  }

  const rebuild = rebuildGraphCache({
    projectRoot: deps.projectRoot,
    databasePath: resolveHarnessPath(harnessRoot, GRAPH_DATABASE_RELATIVE_PATH),
  });
  rebuild.database.close();
  return {
    nodes: nodesAdded,
    edges: edgesAdded,
    revisions,
    runs_linked: runsLinked,
    evaluations,
    evidence_links: evidenceLinks,
    findings_created: findingsCreated,
    findings_superseded: findingsSuperseded,
    block_edges_retired: blockEdgesRetired,
    finding_edges_retired: findingEdgesRetired,
    skipped: [...skipped].sort(),
  };
}
