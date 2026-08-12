import { NODE_TYPES, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";

/**
 * Graph integrity invariants. Four properties are checked over the full
 * committed record set (every node revision and every edge, regardless of
 * status):
 *
 * 1. Dangling edge rejection: every edge endpoint must resolve to a node id.
 * 2. Relation compatibility: the (relation, source type, target type) triple
 *    must be admitted by the core relation rules of design section 8.3.
 * 3. Version monotonicity: revisions of a node id start at 1 and never skip;
 *    duplicate revisions are tolerated here because the materializer already
 *    blocks digest forks with a dedicated typed error.
 * 4. Dependency cycles: active DEPENDS_ON edges (proposed or accepted) must
 *    not close a loop between tasks; rejected or superseded edges are history
 *    and cannot create a cycle.
 *
 * Checks are pure and deterministic: the same records always produce the same
 * violations in the same order, so callers can assert exact output.
 */
export type IntegrityViolationKind =
  "dangling_edge" | "invalid_relation" | "version_nonmonotonic" | "dependency_cycle";

export interface IntegrityViolation {
  readonly kind: IntegrityViolationKind;
  readonly message: string;
  /** Edge or node ids involved, sorted for deterministic reporting. */
  readonly subjectIds: readonly string[];
}

export class GraphIntegrityError extends Error {
  readonly kind = "graph_integrity_error" as const;
  readonly violations: readonly IntegrityViolation[];

  constructor(violations: readonly IntegrityViolation[]) {
    super(
      `graph integrity violated: ${violations.map((violation) => violation.message).join("; ")}`,
    );
    this.name = "GraphIntegrityError";
    this.violations = violations;
  }
}

type NodeType = NodeRecord["type"];
type RelationType = EdgeRecord["type"];

export interface RelationRule {
  readonly type: RelationType;
  readonly sources: readonly NodeType[];
  readonly targets: readonly NodeType[];
}

/** Nodes that carry authoritative revisions (design 8.5 mutation rules). */
export const VERSIONABLE_NODE_TYPES = [
  "Requirement",
  "Constraint",
  "Decision",
  "Component",
  "ExecutionPlan",
  "Task",
  "CodeArtifact",
  "Policy",
  "ToolDefinition",
  "Test",
  "EvaluationCase",
  "Gate",
] as const satisfies readonly NodeType[];

/**
 * Core relation compatibility from design section 8.3. Each entry admits a
 * (relation, source type, target type) triple; several entries may share a
 * relation when different families reuse it (for example PRODUCES).
 */
export const RELATION_COMPATIBILITY: readonly RelationRule[] = [
  { type: "DERIVES_FROM", sources: VERSIONABLE_NODE_TYPES, targets: VERSIONABLE_NODE_TYPES },
  { type: "SUPERSEDES", sources: VERSIONABLE_NODE_TYPES, targets: VERSIONABLE_NODE_TYPES },
  { type: "GENERATED_BY", sources: VERSIONABLE_NODE_TYPES, targets: ["Run"] },
  { type: "RESUMES", sources: ["Run"], targets: ["Run"] },
  { type: "DECOMPOSES_TO", sources: ["Intent"], targets: ["Requirement"] },
  { type: "ADDRESSES", sources: ["Decision"], targets: ["Requirement"] },
  { type: "CONSTRAINED_BY", sources: VERSIONABLE_NODE_TYPES, targets: ["Constraint"] },
  { type: "GOVERNED_BY", sources: VERSIONABLE_NODE_TYPES, targets: ["Policy"] },
  { type: "SHAPES", sources: ["Decision"], targets: ["Component"] },
  { type: "REALIZES", sources: ["CodeArtifact"], targets: ["Component"] },
  { type: "IMPLEMENTS", sources: ["Task"], targets: ["Requirement", "Decision"] },
  { type: "VERIFIES", sources: ["Test"], targets: ["Requirement", "Constraint"] },
  { type: "EVALUATES", sources: ["EvaluationCase"], targets: ["Task", "Run"] },
  { type: "EXECUTES", sources: ["Run"], targets: ["Task", "Gate", "EvaluationCase"] },
  { type: "INVOKES", sources: ["Run"], targets: ["ToolDefinition"] },
  { type: "PRODUCES", sources: ["Run"], targets: ["Evidence"] },
  { type: "PRODUCES", sources: ["RootCauseAnalysis"], targets: ["ImprovementCandidate"] },
  { type: "SUPPORTS", sources: ["Evidence"], targets: ["Test", "Requirement", "EvaluationCase"] },
  { type: "REFUTES", sources: ["Evidence"], targets: ["Test", "Requirement", "EvaluationCase"] },
  { type: "VIOLATES", sources: ["Finding"], targets: ["Requirement", "Constraint", "Policy"] },
  { type: "CONTAINS", sources: ["Project", "Repository", "Iteration"], targets: NODE_TYPES },
  { type: "CONTAINS", sources: ["ExecutionPlan"], targets: ["Task"] },
  { type: "DEPENDS_ON", sources: ["Task"], targets: ["Task"] },
  { type: "USES_CONTEXT", sources: ["Run"], targets: ["ContextBundle"] },
  { type: "CAPTURES", sources: ["Checkpoint"], targets: ["Run", "Iteration"] },
  { type: "BLOCKS", sources: ["Finding"], targets: ["Task", "Iteration"] },
  { type: "REQUESTS_APPROVAL_FOR", sources: ["ApprovalRequest"], targets: VERSIONABLE_NODE_TYPES },
  { type: "RESOLVES", sources: ["Approval"], targets: ["ApprovalRequest"] },
  { type: "APPROVES", sources: ["Approval"], targets: VERSIONABLE_NODE_TYPES },
  { type: "DIAGNOSED_BY", sources: ["Finding"], targets: ["RootCauseAnalysis"] },
  {
    type: "PROPOSES_CHANGE_TO",
    sources: ["ImprovementCandidate"],
    targets: VERSIONABLE_NODE_TYPES,
  },
  { type: "TRIGGERS", sources: ["Finding", "ImprovementCandidate"], targets: ["ImpactSet"] },
];

export function isRelationCompatible(
  type: RelationType,
  sourceType: NodeType,
  targetType: NodeType,
): boolean {
  return RELATION_COMPATIBILITY.some(
    (rule) =>
      rule.type === type && rule.sources.includes(sourceType) && rule.targets.includes(targetType),
  );
}

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checkDanglingEdges(
  edges: readonly EdgeRecord[],
  nodeIds: ReadonlySet<string>,
): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const sorted = [...edges].sort((left, right) => byId(left.id, right.id));
  for (const edge of sorted) {
    const missing = [edge.source_id, edge.target_id].filter((id) => !nodeIds.has(id));
    if (missing.length > 0) {
      violations.push({
        kind: "dangling_edge",
        message: `edge ${edge.id} references unknown node(s): ${missing.join(", ")}`,
        subjectIds: [edge.id],
      });
    }
  }
  return violations;
}

function checkRelationCompatibility(
  edges: readonly EdgeRecord[],
  nodeIds: ReadonlySet<string>,
  typeById: ReadonlyMap<string, NodeType>,
): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const sorted = [...edges].sort((left, right) => byId(left.id, right.id));
  for (const edge of sorted) {
    // A dangling edge is already reported; typing it would be noise.
    if (!nodeIds.has(edge.source_id) || !nodeIds.has(edge.target_id)) continue;
    const sourceType = typeById.get(edge.source_id) as NodeType;
    const targetType = typeById.get(edge.target_id) as NodeType;
    if (!isRelationCompatible(edge.type, sourceType, targetType)) {
      violations.push({
        kind: "invalid_relation",
        message: `edge ${edge.id} has incompatible relation ${edge.type}: ${sourceType} -> ${targetType}`,
        subjectIds: [edge.id],
      });
    }
  }
  return violations;
}

function checkVersionMonotonicity(nodes: readonly NodeRecord[]): IntegrityViolation[] {
  const revisionsById = new Map<string, number[]>();
  for (const node of nodes) {
    const revisions = revisionsById.get(node.id) ?? [];
    revisions.push(node.revision);
    revisionsById.set(node.id, revisions);
  }
  const violations: IntegrityViolation[] = [];
  for (const id of [...revisionsById.keys()].sort(byId)) {
    const revisions = [...(revisionsById.get(id) as number[])].sort((left, right) => left - right);
    let expected = 1;
    for (const revision of revisions) {
      if (revision < expected) continue; // Duplicate revision; forks are typed elsewhere.
      if (revision !== expected) {
        violations.push({
          kind: "version_nonmonotonic",
          message: `node ${id} jumps from revision ${expected - 1} to ${revision}; revisions must be contiguous from 1`,
          subjectIds: [id],
        });
        break;
      }
      expected += 1;
    }
    if (revisions[0] !== undefined && revisions[0] < 1) {
      violations.push({
        kind: "version_nonmonotonic",
        message: `node ${id} has illegal revision ${revisions[0]}; revisions start at 1`,
        subjectIds: [id],
      });
    }
  }
  return violations;
}

/** Edges whose status still participates in graph semantics. */
function isActive(edge: EdgeRecord): boolean {
  return edge.status === "proposed" || edge.status === "accepted";
}

function checkDependencyCycles(edges: readonly EdgeRecord[]): IntegrityViolation[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "DEPENDS_ON" || !isActive(edge)) continue;
    const targets = adjacency.get(edge.source_id) ?? [];
    targets.push(edge.target_id);
    adjacency.set(edge.source_id, targets);
  }
  for (const targets of adjacency.values()) targets.sort(byId);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const target of adjacency.get(node) ?? []) {
      const targetColor = color.get(target) ?? WHITE;
      if (targetColor === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(target)), target]);
      } else if (targetColor === WHITE) {
        visit(target);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };
  for (const node of [...adjacency.keys()].sort(byId)) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }

  return cycles.map((cycle) => ({
    kind: "dependency_cycle" as const,
    message: `illegal DEPENDS_ON cycle: ${cycle.join(" -> ")}`,
    subjectIds: [...new Set(cycle)].sort(byId),
  }));
}

/**
 * Run every integrity check and return all violations in deterministic order.
 * An empty result means the graph satisfies every invariant.
 */
export function checkGraphIntegrity(
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
): IntegrityViolation[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const typeById = new Map<string, NodeType>();
  for (const node of [...nodes].sort((left, right) => byId(left.id, right.id))) {
    if (!typeById.has(node.id)) typeById.set(node.id, node.type);
  }
  return [
    ...checkDanglingEdges(edges, nodeIds),
    ...checkRelationCompatibility(edges, nodeIds, typeById),
    ...checkVersionMonotonicity(nodes),
    ...checkDependencyCycles(edges),
  ];
}

/** Throw a typed GraphIntegrityError when any invariant is violated. */
export function assertGraphIntegrity(
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
): void {
  const violations = checkGraphIntegrity(nodes, edges);
  if (violations.length > 0) throw new GraphIntegrityError(violations);
}
