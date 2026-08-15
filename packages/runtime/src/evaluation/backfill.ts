import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import {
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
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";

export interface EvaluationBackfillDependencies {
  readonly projectRoot: string;
  readonly readBaseline: () => string;
  readonly now?: () => string;
}

export interface EvaluationBackfillResult {
  readonly evaluations: number;
  readonly nodes: number;
  readonly edges: number;
  readonly skipped: readonly string[];
}

interface EvaluateArtifact {
  readonly iteration_id: string;
  readonly run_digest: string;
  readonly result: {
    readonly evidenceId: string;
    readonly passed: boolean;
    readonly record: Record<string, unknown>;
  };
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

function evaluationKey(evidenceId: string, digest: string): string {
  return `${evidenceId}\0${digest}`;
}

function edgeId(type: EdgeRecord["type"], sourceId: string, targetId: string): string {
  return `edge_${contentDigest({ type, source: sourceId, target: targetId }).slice(0, 16)}`;
}

/**
 * Backfill graph associations for evaluation reports committed by Harness
 * versions that stored the report artifact but omitted its nodes and edges.
 * Existing records are never rewritten; one append-only migration operation
 * adds only missing EvaluationCase/Evidence nodes and verdict-chain edges.
 */
export async function backfillEvaluationGraph(
  deps: EvaluationBackfillDependencies,
): Promise<EvaluationBackfillResult> {
  const harnessRoot = harnessRootFor(deps.projectRoot);
  const { database } = materializeLedger({
    projectRoot: deps.projectRoot,
    databasePath: ":memory:",
  });
  const currentNodes = new Map<string, NodeRecord>();
  const activeEdgeIds = new Set<string>();
  try {
    let cursor: string | undefined;
    do {
      const page = pageNodes(database, {
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
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
        if (edge.status === "accepted" || edge.status === "proposed") activeEdgeIds.add(edge.id);
      }
      edgeCursor = page.nextCursor;
    } while (edgeCursor !== undefined);
  } finally {
    database.close();
  }

  const runsByDigest = new Map<string, string>();
  for (const path of filesBelow(resolveHarnessPath(harnessRoot, "artifacts/run-results"))) {
    const runId = basename(path, ".json");
    if (currentNodes.get(runId)?.type !== "Run") continue;
    const result = JSON.parse(readFileSync(path, "utf8")) as unknown;
    runsByDigest.set(sha256Hex(canonicalizeJson(result)), runId);
  }

  const summaries = new Map<string, EvaluateArtifact>();
  for (const path of filesBelow(resolveHarnessPath(harnessRoot, "artifacts/evaluate"))) {
    const artifact = JSON.parse(readFileSync(path, "utf8")) as EvaluateArtifact;
    const digest = artifact.result.record["digest"];
    if (typeof digest !== "string") continue;
    summaries.set(evaluationKey(artifact.result.evidenceId, digest), artifact);
  }

  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const edges: EdgeRecord[] = [];
  const skipped: string[] = [];
  let evaluations = 0;
  const appendNode = (input: {
    readonly id: string;
    readonly type: "Evidence" | "EvaluationCase";
    readonly status: "proposed" | "accepted";
    readonly iterationId: string;
    readonly runId: string;
    readonly timestamp: string;
    readonly evidenceDigest: string;
    readonly extension: Record<string, unknown>;
    readonly directory: string;
  }): void => {
    const current = currentNodes.get(input.id);
    const binding = current?.extensions?.["harness.evaluation"];
    if (
      current?.status === input.status &&
      typeof binding === "object" &&
      binding !== null &&
      (binding as Record<string, unknown>)["evidence_digest"] === input.evidenceDigest
    ) {
      return;
    }
    const revision = (current?.revision ?? 0) + 1;
    const content: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "node",
      id: input.id,
      type: input.type,
      revision,
      status: input.status,
      source: "migration",
      provenance: {
        iteration_id: input.iterationId,
        run_id: input.runId,
        actor: "harness-evaluation-backfill",
        timestamp: input.timestamp,
      },
      confidence: 1,
      extensions: { "harness.evaluation": input.extension },
    };
    const node = { ...content, digest: contentDigest(content) };
    const validation = validateSchema("node", node);
    if (!validation.valid) {
      throw new Error(
        `invalid backfilled ${input.type} node ${input.id}: ${validation.errors
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    artifacts.push({
      path: `artifacts/${input.directory}/${input.id}/${String(revision)}.json`,
      content: `${canonicalizeJson(node)}\n`,
    });
    currentNodes.set(input.id, node as unknown as NodeRecord);
  };
  const appendEdge = (
    type: EdgeRecord["type"],
    sourceId: string,
    targetId: string,
    iterationId: string,
    runId: string,
    timestamp: string,
  ): void => {
    const id = edgeId(type, sourceId, targetId);
    if (activeEdgeIds.has(id)) return;
    const content: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "edge",
      id,
      type,
      source_id: sourceId,
      target_id: targetId,
      status: "accepted",
      source: "migration",
      provenance: {
        iteration_id: iterationId,
        run_id: runId,
        actor: "harness-evaluation-backfill",
        timestamp,
      },
      confidence: 1,
    };
    const edge = { ...content, digest: contentDigest(content) };
    const validation = validateSchema("edge", edge);
    if (!validation.valid) {
      throw new Error(
        `invalid backfilled ${type} edge: ${validation.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    edges.push(edge as unknown as EdgeRecord);
    activeEdgeIds.add(id);
  };

  for (const path of filesBelow(resolveHarnessPath(harnessRoot, "artifacts/evaluations"))) {
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const evidenceId = record["evidence_id"];
    const evidenceDigest = record["digest"];
    const subjectId = record["subject_id"];
    const createdAt = record["created_at"];
    const provisional = record["provisional"];
    const extensionValue =
      typeof record["extensions"] === "object" && record["extensions"] !== null
        ? (record["extensions"] as Record<string, unknown>)["harness.evaluation"]
        : undefined;
    const extension =
      typeof extensionValue === "object" && extensionValue !== null
        ? (extensionValue as Record<string, unknown>)
        : undefined;
    const caseId = extension?.["case_id"];
    if (
      typeof evidenceId !== "string" ||
      typeof evidenceDigest !== "string" ||
      typeof subjectId !== "string" ||
      typeof createdAt !== "string" ||
      typeof provisional !== "boolean" ||
      typeof caseId !== "string"
    ) {
      skipped.push(`${path}: incomplete evaluation record`);
      continue;
    }
    const evaluationExtension = extension as Record<string, unknown>;
    const summary = summaries.get(evaluationKey(evidenceId, evidenceDigest));
    const runId = summary === undefined ? undefined : runsByDigest.get(summary.run_digest);
    if (summary === undefined || runId === undefined) {
      skipped.push(`${evidenceId}: no matching Run`);
      continue;
    }
    if (currentNodes.get(subjectId)?.type !== "Task") {
      skipped.push(`${evidenceId}: unknown Task ${subjectId}`);
      continue;
    }
    const status = provisional ? "proposed" : "accepted";
    appendNode({
      id: evidenceId,
      type: "Evidence",
      status,
      iterationId: summary.iteration_id,
      runId,
      timestamp: createdAt,
      evidenceDigest,
      extension: {
        evidence_digest: evidenceDigest,
        ...(record["evidence_type"] === undefined
          ? {}
          : { evidence_type: record["evidence_type"] }),
        subject_id: subjectId,
        provisional,
        passed: summary.result.passed,
      },
      directory: "evaluation-evidence-nodes",
    });
    appendNode({
      id: caseId,
      type: "EvaluationCase",
      status,
      iterationId: summary.iteration_id,
      runId,
      timestamp: createdAt,
      evidenceDigest,
      extension: {
        evidence_id: evidenceId,
        evidence_digest: evidenceDigest,
        ...(evaluationExtension["case_digest"] === undefined
          ? {}
          : { case_digest: evaluationExtension["case_digest"] }),
        subject_id: subjectId,
        ...(evaluationExtension["visibility"] === undefined
          ? {}
          : { visibility: evaluationExtension["visibility"] }),
        passed: summary.result.passed,
      },
      directory: "evaluation-case-nodes",
    });
    appendEdge("EXECUTES", runId, subjectId, summary.iteration_id, runId, createdAt);
    appendEdge("PRODUCES", runId, evidenceId, summary.iteration_id, runId, createdAt);
    appendEdge("SUPPORTS", evidenceId, caseId, summary.iteration_id, runId, createdAt);
    appendEdge("EVALUATES", caseId, subjectId, summary.iteration_id, runId, createdAt);
    appendEdge("EVALUATES", caseId, runId, summary.iteration_id, runId, createdAt);
    evaluations += 1;
  }

  if (artifacts.length === 0 && edges.length === 0) {
    return { evaluations, nodes: 0, edges: 0, skipped };
  }
  const last = readCommittedOperations(harnessRoot).at(-1);
  if (last === undefined) throw new Error("cannot backfill evaluations without a ledger operation");
  const repository = new LedgerRepository({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  await repository.commit({
    ledger_operation_id: `ledger_${ulid()}`,
    workflow_operation_id: last.manifest.workflow_operation_id,
    attempt_id: last.manifest.attempt_id,
    expected_baseline: deps.readBaseline(),
    artifacts,
    edges,
    events: [],
  });
  return { evaluations, nodes: artifacts.length, edges: edges.length, skipped };
}
