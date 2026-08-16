import { existsSync, readFileSync, readdirSync } from "node:fs";

import {
  LedgerRepository,
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  readManagedManifest,
  resolveHarnessPath,
  ulid,
  validateSchema,
  type CommitHooks,
  type EdgeRecord,
  type LifecycleEvent,
  type LockTuning,
  type NodeRecord,
} from "@universal-harness-internal/core";
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";

import { projectFindingGroups } from "./groups.js";
import { readFindingGovernance } from "./governance.js";
import { evidenceBindingsOf, type GateEvidenceRecord } from "../gates/evidence.js";
import { hashWorktreeCode } from "../snapshot/anchor.js";
import { buildFindingLifecycleEvent } from "./lifecycle.js";

export const FINDING_GROUP_ACTIONS = ["accept", "close", "supersede"] as const;
export type FindingGroupAction = (typeof FINDING_GROUP_ACTIONS)[number];

export interface FindingGroupDependencies {
  readonly projectRoot: string;
  readonly readBaseline: () => string;
  readonly now?: () => string;
  readonly newId?: (kind: string) => string;
  readonly hooks?: CommitHooks;
  readonly lock?: LockTuning;
}

export interface ResolveFindingGroupInput {
  readonly groupId: string;
  readonly membershipDigest: string;
  readonly action: FindingGroupAction;
  readonly actor: string;
  readonly evidenceId?: string;
}

export interface ResolvedFindingGroup {
  readonly groupId: string;
  readonly membershipDigest: string;
  readonly action: FindingGroupAction;
  readonly status: "accepted" | "closed" | "superseded" | "noop";
  readonly members: readonly string[];
}

export type FindingGroupErrorKind =
  | "finding_group_not_found"
  | "finding_group_digest_mismatch"
  | "invalid_finding_group_evidence"
  | "invalid_finding_group_transition";

export class FindingGroupError extends Error {
  readonly kind: FindingGroupErrorKind;

  constructor(kind: FindingGroupErrorKind, message: string) {
    super(message);
    this.name = "FindingGroupError";
    this.kind = kind;
  }
}

function nowOf(deps: FindingGroupDependencies): string {
  return deps.now?.() ?? new Date().toISOString();
}

function newId(deps: FindingGroupDependencies, kind: string): string {
  return deps.newId?.(kind) ?? `${kind}_${ulid()}`;
}

function allFindingNodes(projectRoot: string): NodeRecord[] {
  const graph = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const nodes: NodeRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = pageNodes(graph.database, {
        type: "Finding",
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      nodes.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return nodes;
  } finally {
    graph.database.close();
  }
}

function allEdges(projectRoot: string): EdgeRecord[] {
  const graph = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const edges: EdgeRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = pageEdges(graph.database, {
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      edges.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return edges;
  } finally {
    graph.database.close();
  }
}

function currentNodes(nodes: readonly NodeRecord[]): NodeRecord[] {
  const current = new Map<string, NodeRecord>();
  for (const node of nodes) {
    const existing = current.get(node.id);
    if (existing === undefined || node.revision > existing.revision) current.set(node.id, node);
  }
  return [...current.values()].filter((node) => node.status !== "tombstoned");
}

function groupIdFor(node: NodeRecord): string | undefined {
  return projectFindingGroups([node])[0]?.group_id;
}

function readFeedback(deps: FindingGroupDependencies, findingId: string): Record<string, unknown> {
  const path = resolveHarnessPath(
    harnessRootFor(deps.projectRoot),
    `artifacts/findings/${findingId}/proposed.json`,
  );
  if (!existsSync(path)) {
    throw new FindingGroupError(
      "invalid_finding_group_transition",
      `finding ${findingId} has no proposed feedback record`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function resealFeedback(
  feedback: Record<string, unknown>,
  status: "accepted" | "closed" | "superseded",
  closure?: { readonly evidenceId: string; readonly actor: string; readonly timestamp: string },
): Record<string, unknown> {
  const content: Record<string, unknown> = { ...feedback, status };
  delete content["digest"];
  if (closure !== undefined) {
    content["extensions"] = {
      ...(typeof feedback["extensions"] === "object" && feedback["extensions"] !== null
        ? (feedback["extensions"] as Record<string, unknown>)
        : {}),
      "harness.closure": {
        evidence_id: closure.evidenceId,
        actor: closure.actor,
        closed_at: closure.timestamp,
      },
    };
  }
  const record = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("feedback", record);
  if (!validation.valid) {
    throw new FindingGroupError(
      "invalid_finding_group_transition",
      `invalid feedback transition: ${validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  return record;
}

function validGroupEvidence(
  deps: FindingGroupDependencies,
  evidenceId: string | undefined,
  members: readonly NodeRecord[],
): GateEvidenceRecord {
  if (evidenceId === undefined) {
    throw new FindingGroupError(
      "invalid_finding_group_evidence",
      "closing a Finding group requires repair Evidence",
    );
  }
  const directory = resolveHarnessPath(
    harnessRootFor(deps.projectRoot),
    `artifacts/evidence/${evidenceId}`,
  );
  if (!existsSync(directory)) {
    throw new FindingGroupError(
      "invalid_finding_group_evidence",
      `unknown repair Evidence ${evidenceId}`,
    );
  }
  const codeDigest = hashWorktreeCode(deps.projectRoot);
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const record = JSON.parse(
      readFileSync(resolveHarnessPath(directory, name), "utf8"),
    ) as GateEvidenceRecord;
    const extension = record.extensions?.["harness.gate"];
    const passed =
      typeof extension === "object" &&
      extension !== null &&
      (extension as Record<string, unknown>)["passed"] === true;
    const bindings = evidenceBindingsOf(record);
    const appliesToEveryMember = members.every((member) =>
      readFindingGovernance(member).subject_ids.includes(record.subject_id),
    );
    if (
      record.evidence_id === evidenceId &&
      !record.provisional &&
      passed &&
      bindings?.code_digests.includes(codeDigest) === true &&
      appliesToEveryMember
    ) {
      return record;
    }
  }
  throw new FindingGroupError(
    "invalid_finding_group_evidence",
    `repair Evidence ${evidenceId} is failed, provisional, stale, or does not cover every member`,
  );
}

function reviseNode(
  node: NodeRecord,
  status: NodeRecord["status"],
  feedbackDigest: string,
  actor: string,
  timestamp: string,
): NodeRecord {
  const findingExtension = node.extensions?.["harness.finding"];
  const base: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(node).filter(([key]) => key !== "digest")),
    revision: node.revision + 1,
    status,
    provenance: { ...node.provenance, actor, timestamp },
    extensions: {
      ...node.extensions,
      "harness.finding": {
        ...(typeof findingExtension === "object" && findingExtension !== null
          ? (findingExtension as Record<string, unknown>)
          : {}),
        feedback_digest: feedbackDigest,
      },
    },
  };
  const record = { ...base, digest: contentDigest(base) };
  const validation = validateSchema("node", record);
  if (!validation.valid) {
    throw new FindingGroupError(
      "invalid_finding_group_transition",
      `invalid Finding node transition: ${validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  return record as unknown as NodeRecord;
}

/** Resolve a digest-bound Finding group in one all-or-nothing Ledger operation. */
export async function resolveFindingGroup(
  deps: FindingGroupDependencies,
  input: ResolveFindingGroupInput,
): Promise<ResolvedFindingGroup> {
  const nodes = currentNodes(allFindingNodes(deps.projectRoot));
  const projection = projectFindingGroups(nodes).find((group) => group.group_id === input.groupId);
  if (projection === undefined) {
    throw new FindingGroupError(
      "finding_group_not_found",
      `unknown finding group ${input.groupId}`,
    );
  }
  if (projection.membership_digest !== input.membershipDigest) {
    throw new FindingGroupError(
      "finding_group_digest_mismatch",
      `finding group ${input.groupId} changed; expected ${input.membershipDigest}, current ${projection.membership_digest}`,
    );
  }
  const members = nodes
    .filter((node) => groupIdFor(node) === input.groupId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const transitioning = members.filter((node) =>
    input.action === "accept"
      ? node.status === "proposed"
      : node.status === "proposed" || node.status === "accepted",
  );
  if (input.action === "close") validGroupEvidence(deps, input.evidenceId, transitioning);
  if (transitioning.length === 0) {
    return {
      groupId: input.groupId,
      membershipDigest: input.membershipDigest,
      action: input.action,
      status: "noop",
      members: members.map((node) => node.id),
    };
  }

  const harnessRoot = harnessRootFor(deps.projectRoot);
  const operations = readCommittedOperations(harnessRoot);
  const last = operations.at(-1);
  if (last === undefined) {
    throw new FindingGroupError(
      "invalid_finding_group_transition",
      "cannot resolve Findings without a committed Ledger operation",
    );
  }
  const timestamp = nowOf(deps);
  const ledgerOperationId = newId(deps, "ledger");
  const workflowOperationId = last.manifest.workflow_operation_id;
  const replay = new LedgerRepository({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
  }).replay();
  const firstSequence =
    replay.events
      .filter((event) => event.workflow_operation_id === workflowOperationId)
      .reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
  const artifacts: { readonly path: string; readonly content: string }[] = [];
  const events: LifecycleEvent[] = [];
  const retiredEdges = new Map<string, EdgeRecord>();
  const projectId = `project_${readManagedManifest(deps.projectRoot).name}`;
  const feedbackStatus =
    input.action === "accept" ? "accepted" : input.action === "close" ? "closed" : "superseded";
  const nodeStatus = input.action === "accept" ? "accepted" : "superseded";
  const eventCause = `group_${input.action}`;
  for (const [index, node] of transitioning.entries()) {
    const feedback = resealFeedback(
      readFeedback(deps, node.id),
      feedbackStatus,
      input.action === "close" && input.evidenceId !== undefined
        ? { evidenceId: input.evidenceId, actor: input.actor, timestamp }
        : undefined,
    );
    const revision = reviseNode(
      node,
      nodeStatus,
      String(feedback["digest"]),
      input.actor,
      timestamp,
    );
    artifacts.push(
      {
        path: `artifacts/findings/${node.id}/${feedbackStatus}.json`,
        content: `${canonicalizeJson(feedback)}\n`,
      },
      {
        path: `artifacts/finding-nodes/${node.id}/${String(revision.revision)}.json`,
        content: `${canonicalizeJson(revision)}\n`,
      },
    );
    events.push(
      buildFindingLifecycleEvent({
        eventId: newId(deps, "event"),
        action: input.action,
        projectId,
        iterationId: node.provenance.iteration_id,
        workflowOperationId,
        ledgerOperationId,
        sequence: firstSequence + index,
        timestamp,
        payload: {
          findingId: node.id,
          from: node.status,
          to: feedbackStatus,
          actor: input.actor,
          cause: eventCause,
          groupId: input.groupId,
          ...(input.evidenceId === undefined ? {} : { evidenceId: input.evidenceId }),
        },
      }),
    );
  }
  if (input.action !== "accept") {
    const transitioningIds = new Set(transitioning.map((node) => node.id));
    for (const edge of allEdges(deps.projectRoot)) {
      if (
        (edge.status !== "accepted" && edge.status !== "proposed") ||
        (!transitioningIds.has(edge.source_id) && !transitioningIds.has(edge.target_id))
      ) {
        continue;
      }
      const content: Record<string, unknown> = {
        ...Object.fromEntries(Object.entries(edge).filter(([key]) => key !== "digest")),
        status: "superseded",
        provenance: { ...edge.provenance, actor: input.actor, timestamp },
      };
      const retired = { ...content, digest: contentDigest(content) };
      const validation = validateSchema("edge", retired);
      if (!validation.valid) {
        throw new FindingGroupError(
          "invalid_finding_group_transition",
          `invalid retired Finding edge: ${validation.errors.map((issue) => issue.message).join("; ")}`,
        );
      }
      retiredEdges.set(edge.id, retired as unknown as EdgeRecord);
    }
  }
  await new LedgerRepository({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    ...(deps.lock === undefined ? {} : { lock: deps.lock }),
  }).commit({
    ledger_operation_id: ledgerOperationId,
    workflow_operation_id: workflowOperationId,
    attempt_id: last.manifest.attempt_id,
    expected_baseline: deps.readBaseline(),
    artifacts,
    edges: [...retiredEdges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    events,
  });
  return {
    groupId: input.groupId,
    membershipDigest: input.membershipDigest,
    action: input.action,
    status: feedbackStatus,
    members: members.map((node) => node.id),
  };
}
