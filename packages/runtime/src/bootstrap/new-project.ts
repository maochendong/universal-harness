import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  LedgerRepository,
  ProjectManifestError,
  assertProjectName,
  createPackLock,
  createProjectManifest,
  initializeManagedLayout,
  type NodeRecord,
} from "@universal-harness-internal/core";

import {
  artifactContentForNode,
  artifactPathForNode,
  edgeRecord,
  iterationNodeRecord,
  lifecycleEvent,
  scannedNodeRecord,
  type RecordContext,
} from "./records.js";
import {
  HARNESS_COMMIT_IDENTITY,
  bootstrapErr,
  bootstrapOk,
  lockedPackForStack,
  newIdOf,
  nowOf,
  projectIdFor,
  repositoryIdFor,
  type BootstrapDependencies,
  type BootstrapResult,
} from "./staging.js";

/**
 * `harness new` bootstrap (design section 12.1, M1 scope): create the project
 * directory and Git repository, initialize the managed control plane, commit
 * the deterministic bootstrap baseline (repository + bootstrap iteration) to
 * the ledger, and open the bootstrap iteration branch. Requirement capture,
 * planning and execution land in later tasks; nothing here fakes them.
 */
export interface NewProjectRequest {
  /** Directory the project directory is created in (CLI passes its cwd). */
  readonly parentDirectory: string;
  readonly name: string;
  readonly intent: string;
}

export interface NewProjectOutcome {
  readonly projectRoot: string;
  readonly name: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly stack: "generic";
  readonly repositoryNodeId: string;
  readonly iterationId: string;
  readonly workflowOperationId: string;
  readonly attemptId: string;
  readonly ledgerOperationId: string;
  /** Commit the first ledger operation binds to (control-plane commit). */
  readonly baselineCommit: string;
  /** HEAD after the baseline commit landed on the bootstrap branch. */
  readonly headCommit: string;
  readonly branch: string;
  readonly layoutCreated: readonly string[];
  readonly layoutReused: readonly string[];
}

export async function createNewProject(
  request: NewProjectRequest,
  deps: BootstrapDependencies,
): Promise<BootstrapResult<NewProjectOutcome>> {
  try {
    assertProjectName(request.name);
  } catch (error) {
    const message = error instanceof ProjectManifestError ? error.message : String(error);
    return bootstrapErr({ kind: "invalid_name", message });
  }
  const parent = resolve(request.parentDirectory);
  if (!existsSync(parent)) {
    return bootstrapErr({
      kind: "parent_not_found",
      message: `parent directory does not exist: ${parent}`,
    });
  }
  const projectRoot = resolve(parent, request.name);
  if (existsSync(projectRoot)) {
    return bootstrapErr({
      kind: "target_exists",
      message: `refusing to overwrite existing path: ${projectRoot}`,
    });
  }
  mkdirSync(projectRoot);

  const initialized = await deps.vcs.initRepository(projectRoot, { initialBranch: "main" });
  if (!initialized.ok) {
    return bootstrapErr({
      kind: "vcs_failure",
      message: `git init failed: ${initialized.error.message}`,
      data: { vcs_kind: initialized.error.kind },
    });
  }

  const projectId = projectIdFor(request.name);
  const repositoryId = repositoryIdFor(request.name);
  let layout: ReturnType<typeof initializeManagedLayout>;
  try {
    layout = initializeManagedLayout({
      projectRoot,
      manifest: createProjectManifest({
        name: request.name,
        repositoryId,
        now: () => nowOf(deps),
      }),
      packLock: createPackLock([lockedPackForStack("generic")]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return bootstrapErr({ kind: "layout_conflict", message });
  }

  const controlPlane = await deps.vcs.commit(projectRoot, {
    message: "harness: initialize control plane",
    paths: [".harness"],
    identity: HARNESS_COMMIT_IDENTITY,
  });
  if (!controlPlane.ok) {
    return bootstrapErr({
      kind: "vcs_failure",
      message: `control-plane commit failed: ${controlPlane.error.message}`,
      data: { vcs_kind: controlPlane.error.kind },
    });
  }
  const baselineCommit = controlPlane.value;

  const workflowOperationId = newIdOf(deps, "workflow");
  const attemptId = newIdOf(deps, "attempt");
  const ledgerOperationId = newIdOf(deps, "bootstrap");
  const iterationId = newIdOf(deps, "iteration");
  const branch = `harness/${iterationId}-bootstrap`;
  const created = await deps.vcs.createBranch(projectRoot, branch);
  if (!created.ok) {
    return bootstrapErr({
      kind: "vcs_failure",
      message: `bootstrap branch failed: ${created.error.message}`,
      data: { vcs_kind: created.error.kind },
    });
  }

  const context: RecordContext = {
    projectId,
    repositoryId,
    iterationId,
    actor: "harness-bootstrap",
    timestamp: nowOf(deps),
  };
  const repositoryNode = scannedNodeRecord(context, {
    type: "Repository",
    locator: `repo://${repositoryId}`,
  });
  const iterationNode = iterationNodeRecord(context, {
    iterationId,
    intent: request.intent,
  });
  const nodes: NodeRecord[] = [repositoryNode, iterationNode];
  const edges = [
    edgeRecord(context, {
      type: "DERIVES_FROM",
      sourceId: iterationNode.id,
      targetId: repositoryNode.id,
      source: "workflow",
    }),
  ];
  const events = [
    lifecycleEvent(context, {
      eventId: newIdOf(deps, "event"),
      eventType: "OperationStarted",
      workflowOperationId,
      ledgerOperationId,
      sequence: 1,
      payload: { intent: request.intent, phase: "bootstrap_baseline" },
    }),
    lifecycleEvent(context, {
      eventId: newIdOf(deps, "event"),
      eventType: "OperationCompleted",
      workflowOperationId,
      ledgerOperationId,
      sequence: 2,
      payload: { outcome: "baseline_committed", phase: "bootstrap_baseline" },
    }),
  ];

  const ledger = new LedgerRepository({
    projectRoot,
    readBaseline: () => baselineCommit,
    now: () => nowOf(deps),
  });
  try {
    await ledger.commit({
      ledger_operation_id: ledgerOperationId,
      workflow_operation_id: workflowOperationId,
      attempt_id: attemptId,
      expected_baseline: baselineCommit,
      artifacts: nodes.map((node) => ({
        path: artifactPathForNode(node),
        content: artifactContentForNode(node),
      })),
      edges,
      events,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return bootstrapErr({
      kind: "ledger_failure",
      message: `baseline ledger commit failed: ${message}`,
    });
  }

  const recorded = await deps.vcs.commit(projectRoot, {
    message: "harness: record bootstrap baseline",
    paths: [".harness"],
    identity: HARNESS_COMMIT_IDENTITY,
  });
  if (!recorded.ok) {
    return bootstrapErr({
      kind: "vcs_failure",
      message: `baseline commit failed: ${recorded.error.message}`,
      data: { vcs_kind: recorded.error.kind },
    });
  }

  return bootstrapOk({
    projectRoot,
    name: request.name,
    projectId,
    repositoryId,
    stack: "generic",
    repositoryNodeId: repositoryNode.id,
    iterationId,
    workflowOperationId,
    attemptId,
    ledgerOperationId,
    baselineCommit,
    headCommit: recorded.value,
    branch,
    layoutCreated: layout.created,
    layoutReused: layout.reused,
  });
}
