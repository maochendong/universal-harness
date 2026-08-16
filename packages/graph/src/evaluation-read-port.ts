import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";
import type { DatabaseSync } from "node:sqlite";

import { pageEdges, pageNodes, type NodeQuery, type Page } from "./query-port.js";

export const EVALUATION_DIMENSIONS = [
  "outcome",
  "safety",
  "trajectory",
  "correct_failure",
  "efficiency",
] as const;

export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];

export interface DimensionVerdict {
  readonly dimension: EvaluationDimension;
  readonly available: boolean;
  readonly score: number | null;
  readonly threshold: number;
  readonly passed: boolean;
  readonly mandatory: boolean;
  readonly deterministic: boolean;
  readonly scorer: string;
  readonly reason: string;
  readonly confidence: number | null;
}

export interface TrajectoryCoverageSummary {
  readonly visibility: string;
  readonly availableFields: readonly string[];
  readonly unavailableFields: readonly string[];
  readonly ratio: number;
}

export interface EvaluationVerdictSummary {
  readonly runId: string;
  readonly subjectId: string;
  readonly caseId: string;
  readonly caseDigest?: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly status: NodeRecord["status"];
  readonly passed: boolean;
  readonly provisional: boolean;
  readonly fresh: boolean;
  readonly visibility?: string;
  readonly dimensions: readonly DimensionVerdict[];
  readonly mandatoryFailures: readonly EvaluationDimension[];
  readonly coverage?: TrajectoryCoverageSummary;
}

export interface EvaluationReadQuery {
  readonly iterationId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface EvaluationCoverageQuery {
  readonly iterationId?: string;
}

export interface EvaluationCoverageSummary {
  readonly evaluated: number;
  readonly total: number;
  readonly ratio: number;
}

export interface EvaluationReadPort {
  page(query?: EvaluationReadQuery): Page<EvaluationVerdictSummary>;
  coverage(query?: EvaluationCoverageQuery): EvaluationCoverageSummary;
}

function allNodes(database: DatabaseSync, query: NodeQuery): NodeRecord[] {
  const items: NodeRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = pageNodes(database, {
      ...query,
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

function allEdges(database: DatabaseSync): EdgeRecord[] {
  const items: EdgeRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = pageEdges(database, {
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

function evaluationExtension(node: NodeRecord): Record<string, unknown> {
  const extension = node.extensions?.["harness.evaluation"];
  return typeof extension === "object" && extension !== null
    ? (extension as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function isEvaluationDimension(value: unknown): value is EvaluationDimension {
  return typeof value === "string" && (EVALUATION_DIMENSIONS as readonly string[]).includes(value);
}

function readDimensions(value: unknown): DimensionVerdict[] {
  if (!Array.isArray(value)) return [];
  const verdicts: DimensionVerdict[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const score = candidate as Record<string, unknown>;
    const dimension = score["dimension"];
    const available = booleanValue(score["available"]);
    const numericScore = score["score"] === null ? null : numberValue(score["score"]);
    const threshold = numberValue(score["threshold"]);
    const passed = booleanValue(score["passed"]);
    const mandatory = booleanValue(score["mandatory"]);
    const deterministic = booleanValue(score["deterministic"]);
    const scorer = stringValue(score["scorer"]);
    const reason = stringValue(score["reason"]);
    const confidence = score["confidence"] === null ? null : numberValue(score["confidence"]);
    if (
      !isEvaluationDimension(dimension) ||
      available === undefined ||
      numericScore === undefined ||
      threshold === undefined ||
      passed === undefined ||
      mandatory === undefined ||
      deterministic === undefined ||
      scorer === undefined ||
      reason === undefined ||
      confidence === undefined
    ) {
      continue;
    }
    verdicts.push({
      dimension,
      available,
      score: numericScore,
      threshold,
      passed,
      mandatory,
      deterministic,
      scorer,
      reason,
      confidence,
    });
  }
  return verdicts;
}

function readCoverage(value: unknown): TrajectoryCoverageSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const coverage = value as Record<string, unknown>;
  const visibility = stringValue(coverage["visibility"]);
  const availableFields = stringArray(coverage["available_fields"]);
  const unavailableFields = stringArray(coverage["unavailable_fields"]);
  const ratio = numberValue(coverage["ratio"]);
  return visibility === undefined ||
    availableFields === undefined ||
    unavailableFields === undefined ||
    ratio === undefined
    ? undefined
    : { visibility, availableFields, unavailableFields, ratio };
}

function active(edge: EdgeRecord): boolean {
  return edge.status === "proposed" || edge.status === "accepted";
}

function accepted(edge: EdgeRecord | undefined): boolean {
  return edge?.status === "accepted";
}

function ratio(evaluated: number, total: number): number {
  return total === 0 ? 0 : Math.round((evaluated / total) * 1e6) / 1e6;
}

/** Build the Dashboard-safe, graph-only read model for evaluation verdicts. */
export function createEvaluationReadPort(database: DatabaseSync): EvaluationReadPort {
  const readState = (): {
    readonly nodes: ReadonlyMap<string, NodeRecord>;
    readonly edges: readonly EdgeRecord[];
  } => {
    const nodes = allNodes(database, {});
    return {
      nodes: new Map(nodes.map((node) => [node.id, node])),
      edges: allEdges(database).filter(active),
    };
  };

  return {
    page(query = {}) {
      const cases = pageNodes(database, {
        type: "EvaluationCase",
        ...(query.iterationId === undefined ? {} : { iterationId: query.iterationId }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      const { nodes, edges } = readState();
      const items: EvaluationVerdictSummary[] = [];
      for (const evaluationCase of cases.items) {
        const caseExtension = evaluationExtension(evaluationCase);
        const evaluatesRun = edges.find(
          (edge) =>
            edge.type === "EVALUATES" &&
            edge.source_id === evaluationCase.id &&
            nodes.get(edge.target_id)?.type === "Run",
        );
        const supports = edges.find(
          (edge) => edge.type === "SUPPORTS" && edge.target_id === evaluationCase.id,
        );
        if (evaluatesRun === undefined || supports === undefined) continue;
        const run = nodes.get(evaluatesRun.target_id);
        const evidence = nodes.get(supports.source_id);
        if (run?.type !== "Run" || evidence?.type !== "Evidence") continue;
        const evidenceExtension = evaluationExtension(evidence);
        const subjectId =
          stringValue(caseExtension["subject_id"]) ?? stringValue(evidenceExtension["subject_id"]);
        const evidenceId = stringValue(caseExtension["evidence_id"]);
        const evidenceDigest = stringValue(caseExtension["evidence_digest"]);
        const boundEvidenceDigest = stringValue(evidenceExtension["evidence_digest"]);
        const passed = booleanValue(caseExtension["passed"]);
        const provisional = booleanValue(evidenceExtension["provisional"]);
        if (
          subjectId === undefined ||
          evidenceId === undefined ||
          evidenceDigest === undefined ||
          passed === undefined
        ) {
          continue;
        }
        const dimensions = readDimensions(
          caseExtension["dimensions"] ?? evidenceExtension["dimensions"],
        );
        const mandatoryFailureValues = stringArray(
          caseExtension["mandatory_failures"] ?? evidenceExtension["mandatory_failures"],
        );
        const mandatoryFailures = (mandatoryFailureValues ?? []).filter(isEvaluationDimension);
        const coverage = readCoverage(caseExtension["coverage"] ?? evidenceExtension["coverage"]);
        const produced = edges.find(
          (edge) =>
            edge.type === "PRODUCES" && edge.source_id === run.id && edge.target_id === evidence.id,
        );
        const evaluatesSubject = edges.find(
          (edge) =>
            edge.type === "EVALUATES" &&
            edge.source_id === evaluationCase.id &&
            edge.target_id === subjectId,
        );
        const completeDimensions = EVALUATION_DIMENSIONS.every((dimension) =>
          dimensions.some((verdict) => verdict.dimension === dimension),
        );
        items.push({
          runId: run.id,
          subjectId,
          caseId: evaluationCase.id,
          ...(stringValue(caseExtension["case_digest"]) === undefined
            ? {}
            : { caseDigest: stringValue(caseExtension["case_digest"]) }),
          evidenceId,
          evidenceDigest,
          status: evaluationCase.status,
          passed,
          provisional: provisional ?? true,
          fresh:
            evaluationCase.status === "accepted" &&
            evidence.status === "accepted" &&
            provisional === false &&
            evidenceId === evidence.id &&
            evidenceDigest === boundEvidenceDigest &&
            completeDimensions &&
            mandatoryFailureValues !== undefined &&
            mandatoryFailures.length === mandatoryFailureValues.length &&
            coverage !== undefined &&
            accepted(evaluatesRun) &&
            accepted(evaluatesSubject) &&
            accepted(supports) &&
            accepted(produced),
          ...(stringValue(caseExtension["visibility"]) === undefined
            ? {}
            : { visibility: stringValue(caseExtension["visibility"]) }),
          dimensions,
          mandatoryFailures,
          ...(coverage === undefined ? {} : { coverage }),
        } as EvaluationVerdictSummary);
      }
      return {
        items,
        ...(cases.nextCursor === undefined ? {} : { nextCursor: cases.nextCursor }),
      };
    },

    coverage(query = {}) {
      const runs = allNodes(database, {
        type: "Run",
        ...(query.iterationId === undefined ? {} : { iterationId: query.iterationId }),
      });
      const { nodes, edges } = readState();
      const runIds = new Set(runs.map((run) => run.id));
      const evaluated = new Set(
        edges
          .filter(
            (edge) =>
              edge.type === "EVALUATES" &&
              edge.status === "accepted" &&
              runIds.has(edge.target_id) &&
              nodes.get(edge.source_id)?.type === "EvaluationCase" &&
              nodes.get(edge.source_id)?.status === "accepted",
          )
          .map((edge) => edge.target_id),
      ).size;
      return { evaluated, total: runs.length, ratio: ratio(evaluated, runs.length) };
    },
  };
}
