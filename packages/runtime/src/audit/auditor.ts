import type { EdgeRecord, NodeRecord } from "@universal-harness-internal/core";

/**
 * Graph audit (design 8.7, plan Task 22). Pure and deterministic: the same
 * committed graph always yields the same findings in the same order. Audit
 * findings carry `origin: "audit"` subjects so they can enter the shared
 * Finding/ImpactSet feedback protocol (design 9.1) -- the auditor diagnoses,
 * it never revises nodes itself.
 */
export const AUDIT_FINDING_KINDS = [
  "traceability_gap",
  "stale_knowledge",
  "contradictory_constraint",
  "orphan_node",
  "missing_verification",
  "unpromoted_high_risk_improvement",
  "unhealthy_context_source",
  "missing_design_artifact",
] as const;

export type AuditFindingKind = (typeof AUDIT_FINDING_KINDS)[number];

export interface AuditFinding {
  readonly kind: AuditFindingKind;
  /** Findings originate from the audit check family (design 8.7). */
  readonly origin: "audit";
  readonly summary: string;
  /** Node or edge ids the finding is about, sorted for determinism. */
  readonly subjects: readonly string[];
  /** True when the finding must be repaired before its iteration completes. */
  readonly blocking: boolean;
}

export interface AuditGraph {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
}

export interface AuditReport {
  readonly findings: readonly AuditFinding[];
  readonly checked_nodes: number;
  readonly checked_edges: number;
}

/** Improvement target layers whose unpromoted candidates are high risk. */
export const HIGH_RISK_IMPROVEMENT_LAYERS = ["policy", "tool"] as const;

const IMPROVEMENT_EXTENSION_KEY = "harness.improvement";

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Current revision per node id, tombstoned revisions removed. */
function currentNodes(nodes: readonly NodeRecord[]): ReadonlyMap<string, NodeRecord> {
  const latest = new Map<string, NodeRecord>();
  for (const node of nodes) {
    const existing = latest.get(node.id);
    if (existing === undefined || node.revision > existing.revision) latest.set(node.id, node);
  }
  const current = new Map<string, NodeRecord>();
  for (const [id, node] of latest) {
    if (node.status !== "tombstoned") current.set(id, node);
  }
  return current;
}

function isActive(edge: EdgeRecord): boolean {
  return edge.status === "proposed" || edge.status === "accepted";
}

function statementOf(node: NodeRecord): string | undefined {
  const extension = node.extensions?.["harness.requirements"];
  if (typeof extension !== "object" || extension === null) return undefined;
  const statement = (extension as Record<string, unknown>).statement;
  return typeof statement === "string" ? statement : undefined;
}

/** Artifact node types expected to be wired into the graph (design 8.7). */
const CONNECTED_NODE_TYPES: readonly NodeRecord["type"][] = [
  "Intent",
  "Requirement",
  "Constraint",
  "Decision",
  "Component",
  "CodeArtifact",
  "Policy",
  "ToolDefinition",
  "Test",
  "EvaluationCase",
  "Gate",
];

function auditTraceability(
  nodes: ReadonlyMap<string, NodeRecord>,
  edges: readonly EdgeRecord[],
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const node of [...nodes.values()].sort((left, right) => byId(left.id, right.id))) {
    if (node.type !== "Requirement" || node.status !== "accepted") continue;
    const implemented = edges.some(
      (edge) => edge.type === "IMPLEMENTS" && edge.target_id === node.id,
    );
    const verified = edges.some((edge) => edge.type === "VERIFIES" && edge.target_id === node.id);
    if (implemented && verified) continue;
    const missing = [
      ...(implemented ? [] : ["no Task IMPLEMENTS it"]),
      ...(verified ? [] : ["no Test VERIFIES it"]),
    ];
    findings.push({
      kind: "traceability_gap",
      origin: "audit",
      summary: `accepted requirement ${node.id} has a traceability gap: ${missing.join(" and ")}`,
      subjects: [node.id],
      blocking: true,
    });
  }
  return findings;
}

function auditStaleKnowledge(
  graph: AuditGraph,
  nodes: ReadonlyMap<string, NodeRecord>,
  edges: readonly EdgeRecord[],
): AuditFinding[] {
  const knownIds = new Set(graph.nodes.map((node) => node.id));
  const findings: AuditFinding[] = [];
  for (const edge of edges) {
    const staleEndpoint = [edge.source_id, edge.target_id].find((id) => {
      if (!knownIds.has(id)) return false; // Dangling edges are integrity errors, not drift.
      const node = nodes.get(id);
      return node === undefined || node.status === "superseded";
    });
    if (staleEndpoint === undefined) continue;
    findings.push({
      kind: "stale_knowledge",
      origin: "audit",
      summary: `active edge ${edge.id} still references retired node ${staleEndpoint}; reroute it to the current revision`,
      subjects: [edge.id, staleEndpoint].sort(byId),
      blocking: false,
    });
  }
  return findings;
}

function auditContradictions(nodes: ReadonlyMap<string, NodeRecord>): AuditFinding[] {
  const byStatement = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.type !== "Constraint" || node.status !== "accepted") continue;
    const statement = statementOf(node);
    if (statement === undefined) continue;
    const key = statement.trim().toLowerCase();
    byStatement.set(key, [...(byStatement.get(key) ?? []), node.id]);
  }
  const findings: AuditFinding[] = [];
  for (const key of [...byStatement.keys()].sort()) {
    const ids = [...(byStatement.get(key) as string[])].sort(byId);
    if (ids.length < 2) continue;
    findings.push({
      kind: "contradictory_constraint",
      origin: "audit",
      summary: `accepted constraints ${ids.join(", ")} state the same rule as separate authorities; reconcile them into one constraint revision`,
      subjects: ids,
      blocking: true,
    });
  }
  return findings;
}

function auditOrphans(
  nodes: ReadonlyMap<string, NodeRecord>,
  edges: readonly EdgeRecord[],
): AuditFinding[] {
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.source_id);
    connected.add(edge.target_id);
  }
  const findings: AuditFinding[] = [];
  for (const node of [...nodes.values()].sort((left, right) => byId(left.id, right.id))) {
    if (!CONNECTED_NODE_TYPES.includes(node.type)) continue;
    if (node.status !== "accepted" && node.status !== "proposed") continue;
    if (connected.has(node.id)) continue;
    findings.push({
      kind: "orphan_node",
      origin: "audit",
      summary: `${node.type} ${node.id} has no active relation to any other node`,
      subjects: [node.id],
      blocking: false,
    });
  }
  return findings;
}

function auditMissingVerification(
  nodes: ReadonlyMap<string, NodeRecord>,
  edges: readonly EdgeRecord[],
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const node of [...nodes.values()].sort((left, right) => byId(left.id, right.id))) {
    if (node.type !== "Test" || node.status !== "accepted") continue;
    const hasEvidence = edges.some(
      (edge) =>
        (edge.type === "SUPPORTS" || edge.type === "REFUTES") &&
        edge.target_id === node.id &&
        nodes.get(edge.source_id)?.type === "Evidence",
    );
    if (hasEvidence) continue;
    findings.push({
      kind: "missing_verification",
      origin: "audit",
      summary: `accepted test ${node.id} has no evidence verdict; run its gate before relying on it`,
      subjects: [node.id],
      blocking: true,
    });
  }
  return findings;
}

function auditUnpromotedImprovements(nodes: ReadonlyMap<string, NodeRecord>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const node of [...nodes.values()].sort((left, right) => byId(left.id, right.id))) {
    if (node.type !== "ImprovementCandidate" || node.status !== "proposed") continue;
    const extension = node.extensions?.[IMPROVEMENT_EXTENSION_KEY];
    const content =
      typeof extension === "object" && extension !== null
        ? (extension as Record<string, unknown>)
        : undefined;
    const layer = typeof content?.target_layer === "string" ? content.target_layer : undefined;
    if (layer === undefined) continue;
    if (!(HIGH_RISK_IMPROVEMENT_LAYERS as readonly string[]).includes(layer)) continue;
    findings.push({
      kind: "unpromoted_high_risk_improvement",
      origin: "audit",
      summary: `high-risk improvement candidate ${node.id} targets the ${layer} layer but remains an unapproved proposal`,
      subjects: [node.id],
      blocking: false,
    });
  }
  return findings;
}

function auditContextHealth(
  nodes: ReadonlyMap<string, NodeRecord>,
  edges: readonly EdgeRecord[],
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const edge of edges) {
    if (edge.type !== "USES_CONTEXT") continue;
    const bundle = nodes.get(edge.target_id);
    if (bundle === undefined || bundle.type !== "ContextBundle") continue;
    if (bundle.status === "superseded") {
      findings.push({
        kind: "unhealthy_context_source",
        origin: "audit",
        summary: `run ${edge.source_id} consumed superseded context bundle ${bundle.id}; recompile context before resuming`,
        subjects: [edge.source_id, bundle.id].sort(byId),
        blocking: true,
      });
    }
  }
  return findings;
}

/**
 * Key design/decision document domains checked once a project shows planning
 * intent. A domain is covered by an accepted documentation artifact whose id
 * or locator matches one of its keywords; the decision domain also accepts
 * any accepted Decision node.
 */
interface DesignArtifactDomain {
  readonly key: string;
  readonly label: string;
  /** Word-boundary patterns matched against the lowercase id/locator text. */
  readonly keywords: readonly RegExp[];
  /** True when the domain only applies to projects with a frontend signal. */
  readonly requiresFrontendSignal?: boolean;
  /** True when an accepted Decision node covers the domain. */
  readonly decisionDomain?: boolean;
}

const DESIGN_ARTIFACT_DOMAINS: readonly DesignArtifactDomain[] = [
  { key: "design", label: "design document", keywords: [/\bdesign\b/u] },
  {
    key: "api-contract",
    label: "API contract",
    keywords: [/\bapi\b/u, /\bcontract\b/u, /\bopenapi\b/u, /\bproto\b/u],
  },
  { key: "data-design", label: "data design document", keywords: [/\bdata\b/u, /\bschema\b/u] },
  {
    key: "frontend-design",
    label: "frontend design document",
    keywords: [/\bfrontend\b/u, /\bui\b/u, /\bux\b/u],
    requiresFrontendSignal: true,
  },
  {
    key: "decision",
    label: "decision record",
    keywords: [/\bdecision\b/u, /\badr\b/u],
    decisionDomain: true,
  },
];

const DOCUMENTATION_LOCATOR_PATTERN = /\.(?:md|markdown|txt|rst|adoc)$/u;

const FRONTEND_SIGNAL_PATTERN =
  /\.(?:tsx|jsx|css|scss|html|vue|svelte)$|\/(?:frontend|web|ui|client)\//u;

/**
 * Lowercase match text of an accepted documentation artifact, or undefined.
 * Adopted scans classify documentation via `harness.scan`; any other doc is
 * recognized by a documentation locator extension.
 */
function documentationTextOf(node: NodeRecord): string | undefined {
  if (node.type !== "CodeArtifact" || node.status !== "accepted") return undefined;
  const scan = node.extensions?.["harness.scan"];
  const classification =
    typeof scan === "object" && scan !== null
      ? (scan as Record<string, unknown>).classification
      : undefined;
  const documented =
    classification === "documentation" ||
    (node.locator !== undefined && DOCUMENTATION_LOCATOR_PATTERN.test(node.locator));
  if (!documented) return undefined;
  return `${node.id} ${node.locator ?? ""}`.toLowerCase();
}

/**
 * Design/decision document coverage (design 8.7). The heuristic stays
 * conservative: it only fires once the graph carries planning intent (a
 * proposed or accepted ExecutionPlan), so a fresh project with a bare intent
 * is never flagged. Missing domains are warnings, not blockers -- the
 * finding routes the gap into the feedback cascade for human review instead
 * of letting the harness write documents on its own authority.
 */
function auditDesignArtifactCoverage(nodes: ReadonlyMap<string, NodeRecord>): AuditFinding[] {
  const planned = [...nodes.values()].some(
    (node) =>
      node.type === "ExecutionPlan" && (node.status === "proposed" || node.status === "accepted"),
  );
  if (!planned) return [];
  const documents = [...nodes.values()]
    .map(documentationTextOf)
    .filter((text): text is string => text !== undefined);
  const hasDecision = [...nodes.values()].some(
    (node) => node.type === "Decision" && node.status === "accepted",
  );
  const hasFrontendSignal = [...nodes.values()].some(
    (node) =>
      node.type === "CodeArtifact" &&
      node.locator !== undefined &&
      FRONTEND_SIGNAL_PATTERN.test(node.locator),
  );
  const findings: AuditFinding[] = [];
  for (const domain of DESIGN_ARTIFACT_DOMAINS) {
    if (domain.requiresFrontendSignal === true && !hasFrontendSignal) continue;
    const covered =
      (domain.decisionDomain === true && hasDecision) ||
      documents.some((text) => domain.keywords.some((keyword) => keyword.test(text)));
    if (covered) continue;
    findings.push({
      kind: "missing_design_artifact",
      origin: "audit",
      summary: `project has an execution plan but no accepted ${domain.label} (domain: ${domain.key}); capture one so the gap can be routed to human review`,
      subjects: [],
      blocking: false,
    });
  }
  return findings;
}

/**
 * Run every audit check over the current graph state. Only active
 * (proposed/accepted) edges participate; rejected or superseded edges are
 * history. Findings come back in kind-declaration order, each internally
 * sorted, so reports diff cleanly in golden tests.
 */
export function auditGraph(graph: AuditGraph): AuditReport {
  const nodes = currentNodes(graph.nodes);
  const edges = graph.edges.filter(isActive).sort((left, right) => byId(left.id, right.id));
  const findings = [
    ...auditTraceability(nodes, edges),
    ...auditStaleKnowledge(graph, nodes, edges),
    ...auditContradictions(nodes),
    ...auditOrphans(nodes, edges),
    ...auditMissingVerification(nodes, edges),
    ...auditUnpromotedImprovements(nodes),
    ...auditContextHealth(nodes, edges),
    ...auditDesignArtifactCoverage(nodes),
  ];
  return { findings, checked_nodes: nodes.size, checked_edges: edges.length };
}
