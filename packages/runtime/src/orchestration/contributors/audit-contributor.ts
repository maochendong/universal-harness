import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readManagedManifest,
  resolveHarnessPath,
  sha256Hex,
  validateSchema,
  type EdgeRecord,
  type LifecycleEvent,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { auditGraph, type AuditFinding, type AuditReport } from "../../audit/auditor.js";
import { findingGovernanceForAudit } from "../../finding/governance.js";
import { planFindingDecay } from "../../finding/decay.js";
import { findingLifecyclePayload } from "../../finding/lifecycle.js";
import { hashWorktreeCode } from "../../snapshot/anchor.js";
import {
  artifactExists,
  commitArtifacts,
  currentAttemptId,
  materializeProjectGraph,
  nowOf,
  readJsonArtifact,
} from "../kernel-coordinator.js";
import type {
  AuditCommitOutcome,
  AuditContribution,
  PipelineContext,
} from "../kernel-coordinator.js";
import { OrchestrationError } from "../pipeline-types.js";

const AUDIT_FINDING_NODE_DIRECTORY = "artifacts/finding-nodes";
/**
 * Deterministic Finding identity for audit gaps: rule kind plus the summary
 * text (which carries the rule's target key, e.g. the subject node id or the
 * missing document domain). The same gap always derives the same id, so an
 * iterate re-run dedupes against the committed record instead of duplicating
 * it.
 */
function auditFindingId(finding: AuditFinding): string {
  const key = sha256Hex(`${finding.kind}\n${finding.summary}`).slice(0, 16);
  return `finding_audit-${finding.kind.replaceAll("_", "-")}-${key}`;
}
function invalidAuditRecord(
  kind: string,
  record: string,
  errors: readonly { message?: string }[],
): OrchestrationError {
  return new OrchestrationError(
    "configuration",
    `invalid audit ${kind} record ${record}: ${errors.map((issue) => issue.message ?? "?").join("; ")}`,
  );
}
interface AuditFindingArtifacts {
  readonly feedbackPath: string;
  readonly feedback: Record<string, unknown>;
  readonly nodePath: string;
  readonly node: Record<string, unknown>;
}
/**
 * Build the feedback record and Finding node for one audit gap. Both follow
 * the shared Finding/ImpactSet feedback protocol shapes (design 9.1), so the
 * gap enters the same cascade as gate and evaluation findings and ends as a
 * human-reviewed ImprovementCandidate -- the harness never writes the missing
 * document on its own authority.
 */
function buildAuditFindingArtifacts(
  ctx: PipelineContext,
  finding: AuditFinding,
  id: string,
): AuditFindingArtifacts {
  const { deps } = ctx;
  const feedbackPath = `artifacts/findings/${id}/proposed.json`;
  const auditExtension = { kind: finding.kind, subjects: [...finding.subjects] };
  const governance = findingGovernanceForAudit(
    finding,
    readManagedManifest(deps.projectRoot).repository_id,
  );
  // A non-blocking finding blocks nothing: no BLOCKS edge, empty subject.
  const blocks = finding.blocking ? [ctx.iterationId] : [];
  // The committed feedback record wins: a later iteration must reuse its
  // digest instead of resealing the same gap under a new timestamp.
  const committed = readJsonArtifact<Record<string, unknown>>(deps, feedbackPath);
  let feedback = committed;
  if (feedback === undefined) {
    const content: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "feedback",
      id,
      type: "Finding",
      iteration_id: ctx.iterationId,
      status: "proposed",
      summary: finding.summary,
      created_at: nowOf(deps),
      extensions: {
        "harness.finding": {
          origin: "audit",
          blocking: finding.blocking,
          violates: [],
          blocks,
          evidence: [],
          ...governance,
        },
        "harness.audit": auditExtension,
      },
    };
    feedback = { ...content, digest: contentDigest(content) };
    const validation = validateSchema("feedback", feedback);
    if (!validation.valid) throw invalidAuditRecord("feedback", id, validation.errors);
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
      iteration_id: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(deps),
    },
    confidence: 1,
    extensions: {
      "harness.finding": {
        feedback_digest: feedback["digest"],
        origin: "audit",
        blocking: finding.blocking,
        violates: [],
        blocks,
        evidence: [],
        ...governance,
      },
      "harness.audit": auditExtension,
    },
  };
  const node = { ...nodeContent, digest: contentDigest(nodeContent) };
  const validation = validateSchema("node", node);
  if (!validation.valid) throw invalidAuditRecord("finding node", id, validation.errors);
  return {
    feedbackPath,
    feedback,
    nodePath: `${AUDIT_FINDING_NODE_DIRECTORY}/${id}/1.json`,
    node,
  };
}
/**
 * Task ids whose task-level quality record (card T5) is fresh and passing
 * (card T3): a record is fresh when its bound code digest still matches the
 * current worktree. The iterate audit hook and `harness audit` both feed
 * this set to the auditor, so `task_stale` never fires for a task whose
 * proof is current.
 */
export function provenQualityTaskIds(projectRoot: string): string[] {
  const root = resolveHarnessPath(harnessRootFor(projectRoot), "artifacts/quality");
  if (!existsSync(root)) return [];
  const codeHash = hashWorktreeCode(projectRoot);
  const proven = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = JSON.parse(readFileSync(absolute, "utf8")) as {
        task_id?: unknown;
        verdict?: unknown;
        bindings?: { code_digests?: unknown };
      };
      if (record.verdict !== "passed" || typeof record.task_id !== "string") continue;
      const codeDigests = record.bindings?.code_digests;
      if (Array.isArray(codeDigests) && codeDigests.includes(codeHash)) {
        proven.add(record.task_id);
      }
    }
  };
  walk(root);
  return [...proven].sort();
}
/**
 * Post-verify/evaluate graph audit (design 8.7 wired into the pipeline). The
 * completing snapshot re-runs the deterministic audit -- the same checks
 * `harness audit` reports -- and commits every gap as a proposed Finding
 * node; blocking gaps also get a BLOCKS edge to the just-completed Iteration
 * node, so they show up in `harness status` blockers and next_action without
 * a manual audit (non-blocking gaps surface as warnings). Finding ids are
 * content-derived (rule kind plus summary), so re-runs dedupe instead of
 * duplicating; a gap that no longer reproduces supersedes its committed
 * Finding instead of lingering as a phantom blocker.
 */
export async function commitAuditFindings(ctx: PipelineContext): Promise<AuditCommitOutcome> {
  const { deps } = ctx;
  const graph = materializeProjectGraph(deps.projectRoot);
  let report: AuditReport;
  let openAuditFindings: NodeRecord[];
  let committedEdgeIds: ReadonlySet<string>;
  let activeFindingEdges: readonly EdgeRecord[];
  let auditNodes: readonly NodeRecord[];
  let auditEdges: readonly EdgeRecord[];
  try {
    auditNodes = graph.nodes;
    auditEdges = graph.edges;
    report = auditGraph(
      { nodes: graph.nodes, edges: graph.edges },
      { provenTaskIds: provenQualityTaskIds(deps.projectRoot) },
    );
    const latestFinding = new Map<string, NodeRecord>();
    for (const node of graph.nodes) {
      if (node.type !== "Finding" || node.source !== "audit") continue;
      const current = latestFinding.get(node.id);
      if (current === undefined || node.revision > current.revision) {
        latestFinding.set(node.id, node);
      }
    }
    openAuditFindings = [...latestFinding.values()].filter(
      (node) => node.status === "proposed" || node.status === "accepted",
    );
    committedEdgeIds = new Set(graph.edges.map((edge) => edge.id));
    const openFindingIds = new Set(openAuditFindings.map((finding) => finding.id));
    activeFindingEdges = graph.edges.filter(
      (edge) =>
        (edge.status === "proposed" || edge.status === "accepted") &&
        (openFindingIds.has(edge.source_id) || openFindingIds.has(edge.target_id)),
    );
  } finally {
    graph.close();
  }

  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const edgeRevisions = new Map<string, EdgeRecord>();
  const lifecycleEvents: {
    readonly eventType: LifecycleEvent["event_type"];
    readonly iterationId: string;
    readonly payload: Record<string, unknown>;
  }[] = [];
  const liveFindingIds = new Set<string>();
  for (const finding of report.findings) {
    const id = auditFindingId(finding);
    liveFindingIds.add(id);
    const built = buildAuditFindingArtifacts(ctx, finding, id);
    if (!artifactExists(deps, built.feedbackPath)) {
      artifacts.push({
        path: built.feedbackPath,
        content: `${canonicalizeJson(built.feedback)}\n`,
      });
    }
    if (!artifactExists(deps, built.nodePath)) {
      artifacts.push({ path: built.nodePath, content: `${canonicalizeJson(built.node)}\n` });
    }
    if (!finding.blocking) continue;
    const edgeId = `edge_${sha256Hex(`BLOCKS:${id}:${ctx.iterationId}`).slice(0, 16)}`;
    if (committedEdgeIds.has(edgeId)) continue;
    const edgeContent: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "edge",
      id: edgeId,
      type: "BLOCKS",
      source_id: id,
      target_id: ctx.iterationId,
      status: "accepted",
      source: "audit",
      provenance: {
        iteration_id: ctx.iterationId,
        actor: "workflow-engine",
        timestamp: nowOf(deps),
      },
      confidence: 1,
    };
    const edge = { ...edgeContent, digest: contentDigest(edgeContent) };
    const validation = validateSchema("edge", edge);
    if (!validation.valid) throw invalidAuditRecord("edge", edgeId, validation.errors);
    edgeRevisions.set(edgeId, edge as unknown as EdgeRecord);
  }

  // A gap that no longer reproduces supersedes its committed Finding: the
  // deterministic re-check is the repair verdict for audit findings. The
  // finding's active BLOCKS edges retire with it -- a superseded node held by
  // a live edge is exactly what the stale_knowledge rule (correctly) flags.
  const decayPlans = planFindingDecay({
    nodes: auditNodes,
    edges: auditEdges,
    liveFindingIds: [...liveFindingIds],
  });
  for (const decay of decayPlans) {
    const existing = decay.finding;
    const revision = existing.revision + 1;
    const path = `${AUDIT_FINDING_NODE_DIRECTORY}/${existing.id}/${String(revision)}.json`;
    if (artifactExists(deps, path)) continue;
    const proposedFeedback = readJsonArtifact<Record<string, unknown>>(
      deps,
      `artifacts/findings/${existing.id}/proposed.json`,
    );
    let feedbackDigest: string | undefined;
    if (proposedFeedback !== undefined) {
      const feedbackContent: Record<string, unknown> = {
        ...proposedFeedback,
        status: "superseded",
      };
      delete feedbackContent["digest"];
      const feedback = { ...feedbackContent, digest: contentDigest(feedbackContent) };
      const feedbackValidation = validateSchema("feedback", feedback);
      if (!feedbackValidation.valid) {
        throw invalidAuditRecord("feedback", existing.id, feedbackValidation.errors);
      }
      feedbackDigest = feedback.digest;
      artifacts.push({
        path: `artifacts/findings/${existing.id}/superseded.json`,
        content: `${canonicalizeJson(feedback)}\n`,
      });
    }
    const base: Record<string, unknown> = Object.fromEntries(
      Object.entries(existing).filter(([key]) => key !== "digest"),
    );
    base.revision = revision;
    base.status = "superseded";
    base.provenance = {
      iteration_id: ctx.iterationId,
      actor: "workflow-engine",
      timestamp: nowOf(deps),
    };
    if (feedbackDigest !== undefined) {
      const findingExtension = existing.extensions?.["harness.finding"];
      base.extensions = {
        ...existing.extensions,
        "harness.finding": {
          ...(typeof findingExtension === "object" && findingExtension !== null
            ? (findingExtension as Record<string, unknown>)
            : {}),
          feedback_digest: feedbackDigest,
        },
      };
    }
    const node = { ...base, digest: contentDigest(base) };
    const validation = validateSchema("node", node);
    if (!validation.valid) throw invalidAuditRecord("finding node", existing.id, validation.errors);
    artifacts.push({ path, content: `${canonicalizeJson(node)}\n` });
    for (const active of activeFindingEdges) {
      if (active.source_id !== existing.id && active.target_id !== existing.id) continue;
      const retiredContent: Record<string, unknown> = Object.fromEntries(
        Object.entries(active).filter(([key]) => key !== "digest"),
      );
      retiredContent.status = "superseded";
      retiredContent.provenance = {
        iteration_id: ctx.iterationId,
        actor: "workflow-engine",
        timestamp: nowOf(deps),
      };
      const retired = { ...retiredContent, digest: contentDigest(retiredContent) };
      const edgeValidation = validateSchema("edge", retired);
      if (!edgeValidation.valid) {
        throw invalidAuditRecord("edge", active.id, edgeValidation.errors);
      }
      edgeRevisions.set(active.id, retired as unknown as EdgeRecord);
    }
    lifecycleEvents.push({
      eventType: "FindingSuperseded",
      iterationId: existing.provenance.iteration_id,
      payload: findingLifecyclePayload({
        findingId: existing.id,
        from: existing.status,
        to: "superseded",
        actor: "workflow-engine",
        cause: decay.cause,
        oldSubjectDigests: decay.oldSubjectDigests,
        newSubjectDigests: decay.newSubjectDigests,
      }),
    });
  }

  const edges = [...edgeRevisions.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (artifacts.length > 0 || edges.length > 0) {
    await commitArtifacts(
      deps,
      ctx.workflowOperationId,
      currentAttemptId(ctx),
      artifacts,
      edges,
      lifecycleEvents,
    );
  }
  return {
    blockingFindingIds: report.findings
      .filter((finding) => finding.blocking)
      .map((finding) => auditFindingId(finding))
      .sort(),
  };
}

/**
 * The advanced_audit module contribution (plan Task 8-A): the coordinator
 * reaches the completion audit only through this registration; without it the
 * Kernel happy path commits zero audit artifacts.
 */
export function createAuditContribution(): AuditContribution {
  return { capability_id: "advanced_audit", commitFindings: commitAuditFindings };
}
