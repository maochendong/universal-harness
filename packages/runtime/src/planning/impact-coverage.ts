import { contentDigest, type NodeRecord } from "@universal-harness-internal/core";

import type { ExecutionKind } from "./mode-selector.js";
import type { GovernanceRisk, PathScope } from "./effective-risk.js";

export type ImpactCoverageLayer =
  | "intent"
  | "requirement"
  | "test"
  | "architecture"
  | "implementation"
  | "path";

export interface ImpactCoverageEntry {
  readonly node_id: string;
  readonly node_type: NodeRecord["type"];
  readonly risk: "low" | "medium" | "high";
}

export interface PathForecast {
  readonly pattern: string;
  readonly scope: PathScope;
  readonly approved: boolean;
}

export interface ImpactCoverageInput {
  readonly executionKind: ExecutionKind;
  readonly entries: readonly ImpactCoverageEntry[];
  readonly forecastPaths: readonly PathForecast[];
}

export interface ImpactCoverageAssessment {
  readonly execution_kind: ExecutionKind;
  readonly entries: readonly ImpactCoverageEntry[];
  readonly status: "complete" | "partial" | "unknown";
  readonly covered_layers: readonly ImpactCoverageLayer[];
  readonly missing_layers: readonly string[];
  readonly forecast_paths: readonly PathForecast[];
  readonly diagnostics: readonly string[];
  readonly risk: GovernanceRisk;
  readonly digest: string;
}

const LAYER_ORDER: readonly ImpactCoverageLayer[] = [
  "intent",
  "requirement",
  "test",
  "architecture",
  "implementation",
  "path",
];
const RISK_RANK: Readonly<Record<GovernanceRisk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maxRisk(left: GovernanceRisk, right: GovernanceRisk): GovernanceRisk {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

function layerFor(type: NodeRecord["type"]): ImpactCoverageLayer | undefined {
  if (type === "Intent") return "intent";
  if (type === "Requirement") return "requirement";
  if (type === "Test") return "test";
  if (type === "Decision" || type === "Component") return "architecture";
  if (type === "CodeArtifact") return "implementation";
  return undefined;
}

export function assessImpactCoverage(input: ImpactCoverageInput): ImpactCoverageAssessment {
  const entries = [...input.entries].sort((left, right) => left.node_id.localeCompare(right.node_id));
  const forecasts = [...input.forecastPaths].sort((left, right) =>
    left.pattern.localeCompare(right.pattern),
  );
  const layers = new Set<ImpactCoverageLayer>();
  let risk: GovernanceRisk = "low";
  for (const entry of entries) {
    const layer = layerFor(entry.node_type);
    if (layer !== undefined) layers.add(layer);
    risk = maxRisk(risk, entry.risk);
  }
  const approvedForecasts = forecasts.filter((forecast) => forecast.approved);
  const boundedPath = approvedForecasts.some(
    (forecast) => forecast.scope === "exact" || forecast.scope === "bounded",
  );
  const broadPath = approvedForecasts.some((forecast) => forecast.scope === "broad");
  if (boundedPath || broadPath) layers.add("path");
  if (broadPath) risk = maxRisk(risk, "high");

  const missing: string[] = [];
  const diagnostics: string[] = [];
  let status: ImpactCoverageAssessment["status"] = "complete";
  if (!layers.has("requirement")) missing.push("requirement");
  if (!layers.has("test")) missing.push("test");
  if (input.executionKind === "agent") {
    if (!layers.has("implementation") && !boundedPath) {
      missing.push("implementation_or_path");
      status = broadPath ? "unknown" : "partial";
    }
  }
  if (missing.some((item) => item === "requirement" || item === "test")) status = "partial";
  if (broadPath) diagnostics.push("broad approved path scope raises risk and cannot prove coverage");
  if (input.executionKind === "agent" && status !== "complete") {
    diagnostics.push("agent execution requires requirement, test and implementation/path coverage");
  }
  const coveredLayers = LAYER_ORDER.filter((layer) => layers.has(layer));
  const base = {
    execution_kind: input.executionKind,
    entries,
    covered_layers: coveredLayers,
    missing_layers: missing,
    forecast_paths: forecasts,
    diagnostics,
    status,
    risk,
  };
  return { ...base, digest: contentDigest(base) };
}
