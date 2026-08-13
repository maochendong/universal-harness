import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  LedgerRepository,
  assertProjectName,
  createPackLock,
  createProjectManifest,
  harnessRootFor,
  initializeManagedLayout,
  resolveHarnessPath,
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
import { scanWorktree, type ScanResult, type StackProfile } from "./scanner.js";
import {
  HARNESS_COMMIT_IDENTITY,
  PREVIEW_DOCUMENT,
  REQUEST_DOCUMENT,
  SEMANTIC_INPUT_DOCUMENT,
  bootstrapErr,
  bootstrapOk,
  discardStagedDocuments,
  lockedPackForStack,
  newIdOf,
  nowOf,
  projectIdFor,
  readStagedDocument,
  repositoryIdFor,
  stagedPreviewDigest,
  writeStagedDocuments,
  type BootstrapDependencies,
  type BootstrapResult,
} from "./staging.js";

/**
 * `harness adopt` bootstrap (design section 12.2): deterministic scan into
 * staging, a typed preview with a stable digest, and — only after an approval
 * decision binds that exact preview digest — an atomic baseline ledger
 * commit. Before approval nothing authoritative changes: no manifest, no
 * ledger operation, no Git mutation. Semantic enrichment is prepared as
 * proposal input (per-file import references) but no inferred edge is
 * committed by this task.
 */
export interface AdoptionPreview {
  readonly preview_format: 1;
  readonly project_name: string;
  readonly project_id: string;
  readonly repository_id: string;
  readonly baseline_commit: string;
  readonly stack: {
    readonly primary: StackProfile;
    readonly detected: readonly StackProfile[];
  };
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly classification: string;
    readonly language?: string;
  }[];
  readonly components: readonly { readonly path: string; readonly file_count: number }[];
  readonly conflicts: readonly { readonly path: string; readonly reason: string }[];
  readonly unknown_items: readonly { readonly path: string; readonly reason: string }[];
  readonly semantic_input_digest: string;
}

export interface SemanticInputEntry {
  readonly path: string;
  readonly language: string;
  readonly references: readonly string[];
}

interface AdoptionRequestDocument {
  readonly intent: string;
  readonly iteration_id: string;
  readonly workflow_operation_id: string;
  readonly attempt_id: string;
  readonly created_at: string;
}

export interface AdoptPreviewRequest {
  readonly projectRoot: string;
  readonly intent: string;
}

export interface AdoptPreviewOutcome {
  readonly projectRoot: string;
  readonly name: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly stagingOperationId: string;
  readonly preview: AdoptionPreview;
  readonly previewDigest: string;
  readonly semanticInput: readonly SemanticInputEntry[];
  readonly baselineCommit: string;
  readonly workflowOperationId: string;
  readonly attemptId: string;
  readonly iterationId: string;
}

export interface AdoptionApproval {
  readonly decision: "approve" | "reject";
  /** Preview digest this decision binds to; a mismatch invalidates it. */
  readonly previewDigest: string;
  readonly actor: string;
}

export interface AdoptCommitRequest {
  readonly projectRoot: string;
  readonly stagingOperationId: string;
  readonly approval: AdoptionApproval;
}

export interface AdoptCommitOutcome {
  readonly committed: boolean;
  /** True when the approval decision was `reject`; staging is preserved. */
  readonly rejected: boolean;
  readonly projectRoot: string;
  readonly repositoryId: string;
  readonly repositoryNodeId?: string;
  readonly iterationId?: string;
  readonly workflowOperationId?: string;
  readonly ledgerOperationId?: string;
  readonly baselineCommit?: string;
  readonly headCommit?: string;
  readonly branch?: string;
  readonly nodeCount?: number;
  readonly edgeCount?: number;
}

/** Derive a valid project name from the adopted directory basename. */
export function projectNameForPath(projectRoot: string): string {
  const slug = basename(projectRoot)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : "project";
}

function buildPreview(
  name: string,
  baselineCommit: string,
  scan: ScanResult,
  semanticInputDigest: string,
): AdoptionPreview {
  return {
    preview_format: 1,
    project_name: name,
    project_id: projectIdFor(name),
    repository_id: repositoryIdFor(name),
    baseline_commit: baselineCommit,
    stack: scan.stack,
    files: scan.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      classification: file.classification,
      ...(file.language === undefined ? {} : { language: file.language }),
    })),
    components: scan.components.map((component) => ({
      path: component.path,
      file_count: component.fileCount,
    })),
    conflicts: scan.conflicts,
    unknown_items: scan.unknownItems,
    semantic_input_digest: semanticInputDigest,
  };
}

function semanticInputOf(scan: ScanResult): SemanticInputEntry[] {
  return scan.files
    .filter((file) => file.language !== undefined)
    .map((file) => ({
      path: file.path,
      language: file.language as string,
      references: file.references,
    }));
}

async function readAdoptableRepository(
  projectRoot: string,
  deps: BootstrapDependencies,
): Promise<BootstrapResult<{ readonly baselineCommit: string }>> {
  const detected = await deps.vcs.detectRepository(projectRoot);
  if (!detected.ok) {
    if (detected.error.kind === "not_a_repository") {
      return bootstrapErr({
        kind: "not_a_repository",
        message: `path is not inside a Git repository: ${projectRoot}`,
      });
    }
    return bootstrapErr({
      kind: "vcs_failure",
      message: `repository detection failed: ${detected.error.message}`,
      data: { vcs_kind: detected.error.kind },
    });
  }
  // Git reports its own canonical root (forward slashes and long path names
  // on Windows, where the caller's path may use 8.3 short-name aliases), so
  // a string comparison can reject the very directory git resolved. Compare
  // device/inode identity instead: same directory, any textual form.
  const detectedRoot = resolve(detected.value.root);
  const callerStat = statSync(projectRoot);
  const detectedStat = statSync(detectedRoot);
  if (callerStat.dev !== detectedStat.dev || callerStat.ino !== detectedStat.ino) {
    return bootstrapErr({
      kind: "not_repository_root",
      message: `adopt the repository root ${detected.value.root}, not ${projectRoot}`,
      data: { repository_root: detected.value.root },
    });
  }
  if (detected.value.head === null) {
    return bootstrapErr({
      kind: "no_baseline_commit",
      message: "repository has no commit to bind as baseline; create one first",
    });
  }
  const status = await deps.vcs.status(projectRoot);
  if (!status.ok) {
    return bootstrapErr({
      kind: "vcs_failure",
      message: `worktree status failed: ${status.error.message}`,
      data: { vcs_kind: status.error.kind },
    });
  }
  // The harness control plane itself (staging previews) is local scratch
  // space, never user work; any other untracked path blocks adoption.
  const untracked = status.value.untracked.filter(
    (path) => path !== ".harness/" && !path.startsWith(".harness/"),
  );
  if (status.value.staged.length > 0 || status.value.unstaged.length > 0 || untracked.length > 0) {
    return bootstrapErr({
      kind: "worktree_dirty",
      message:
        "worktree has uncommitted or untracked changes; commit or stash them before adoption",
      data: {
        staged: status.value.staged.length,
        unstaged: status.value.unstaged.length,
        untracked: untracked.length,
      },
    });
  }
  return bootstrapOk({ baselineCommit: detected.value.head });
}

export async function prepareAdoption(
  request: AdoptPreviewRequest,
  deps: BootstrapDependencies,
): Promise<BootstrapResult<AdoptPreviewOutcome>> {
  const projectRoot = resolve(request.projectRoot);
  if (!existsSync(projectRoot)) {
    return bootstrapErr({
      kind: "path_not_found",
      message: `path does not exist: ${projectRoot}`,
    });
  }
  if (!statSync(projectRoot).isDirectory()) {
    return bootstrapErr({
      kind: "not_a_directory",
      message: `path is not a directory: ${projectRoot}`,
    });
  }
  const manifestProbe = resolveHarnessPath(harnessRootFor(projectRoot), "manifest.yaml");
  if (existsSync(manifestProbe)) {
    return bootstrapErr({
      kind: "already_managed",
      message: `path is already a managed project: ${projectRoot}`,
    });
  }
  const repository = await readAdoptableRepository(projectRoot, deps);
  if (!repository.ok) return repository;

  const name = projectNameForPath(projectRoot);
  try {
    assertProjectName(name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return bootstrapErr({ kind: "invalid_name", message });
  }
  const scan = scanWorktree(projectRoot);
  const semanticInput = semanticInputOf(scan);
  const semanticInputDigest = stagedPreviewDigest(semanticInput);
  const preview = buildPreview(name, repository.value.baselineCommit, scan, semanticInputDigest);
  const previewDigest = stagedPreviewDigest(preview);

  const stagingOperationId = newIdOf(deps, "adopt-scan");
  const requestDocument: AdoptionRequestDocument = {
    intent: request.intent,
    iteration_id: newIdOf(deps, "iteration"),
    workflow_operation_id: newIdOf(deps, "workflow"),
    attempt_id: newIdOf(deps, "attempt"),
    created_at: nowOf(deps),
  };
  writeStagedDocuments(projectRoot, stagingOperationId, {
    [PREVIEW_DOCUMENT]: preview,
    [SEMANTIC_INPUT_DOCUMENT]: semanticInput,
    [REQUEST_DOCUMENT]: requestDocument,
  });

  return bootstrapOk({
    projectRoot,
    name,
    projectId: preview.project_id,
    repositoryId: preview.repository_id,
    stagingOperationId,
    preview,
    previewDigest,
    semanticInput,
    baselineCommit: repository.value.baselineCommit,
    workflowOperationId: requestDocument.workflow_operation_id,
    attemptId: requestDocument.attempt_id,
    iterationId: requestDocument.iteration_id,
  });
}

/**
 * Read back a staged adoption preview for the approval flow (design 11.3):
 * the adopting user approves one exact staging operation, and the commit path
 * re-binds the stored preview digest. Returns `undefined` when no staged
 * preview exists for the id.
 */
export function readStagedAdoptionPreview(
  projectRoot: string,
  stagingOperationId: string,
): { readonly preview: AdoptionPreview; readonly previewDigest: string } | undefined {
  const preview = readStagedDocument(resolve(projectRoot), stagingOperationId, PREVIEW_DOCUMENT) as
    AdoptionPreview | undefined;
  if (preview === undefined) return undefined;
  return { preview, previewDigest: stagedPreviewDigest(preview) };
}

/**
 * Commit the staged baseline after approval. The approval decision must bind
 * the staged preview digest, and the repository is re-verified (HEAD, clean
 * worktree, identical rescan) before any byte is committed; drift or a
 * binding mismatch blocks with a typed error and leaves authority untouched.
 */
export async function commitAdoption(
  request: AdoptCommitRequest,
  deps: BootstrapDependencies,
): Promise<BootstrapResult<AdoptCommitOutcome>> {
  const projectRoot = resolve(request.projectRoot);
  const preview = readStagedDocument(projectRoot, request.stagingOperationId, PREVIEW_DOCUMENT) as
    AdoptionPreview | undefined;
  const requestDocument = readStagedDocument(
    projectRoot,
    request.stagingOperationId,
    REQUEST_DOCUMENT,
  ) as AdoptionRequestDocument | undefined;
  if (preview === undefined || requestDocument === undefined) {
    return bootstrapErr({
      kind: "staging_not_found",
      message: `no staged adoption preview: ${request.stagingOperationId}`,
    });
  }
  const previewDigest = stagedPreviewDigest(preview);

  if (request.approval.decision === "reject") {
    // Rejected staging stays available for revision or explicit discard.
    return bootstrapOk({
      committed: false,
      rejected: true,
      projectRoot,
      repositoryId: preview.repository_id,
    });
  }
  if (request.approval.previewDigest !== previewDigest) {
    return bootstrapErr({
      kind: "approval_binding_mismatch",
      message: "approval decision does not bind the staged preview digest",
      data: { staged: previewDigest, bound: request.approval.previewDigest },
    });
  }

  const repository = await readAdoptableRepository(projectRoot, deps);
  if (!repository.ok) return repository;
  if (repository.value.baselineCommit !== preview.baseline_commit) {
    return bootstrapErr({
      kind: "preview_drift",
      message: "HEAD moved since the preview was staged; re-run the adoption preview",
      data: { staged: preview.baseline_commit, current: repository.value.baselineCommit },
    });
  }
  const freshScan = scanWorktree(projectRoot);
  const freshPreview = buildPreview(
    preview.project_name,
    preview.baseline_commit,
    freshScan,
    stagedPreviewDigest(semanticInputOf(freshScan)),
  );
  if (stagedPreviewDigest(freshPreview) !== previewDigest) {
    return bootstrapErr({
      kind: "preview_drift",
      message: "repository content changed since the preview was staged; re-run the preview",
    });
  }

  const scan = freshScan;
  try {
    initializeManagedLayout({
      projectRoot,
      manifest: createProjectManifest({
        name: preview.project_name,
        repositoryId: preview.repository_id,
        now: () => nowOf(deps),
      }),
      packLock: createPackLock([lockedPackForStack(scan.stack.primary)]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return bootstrapErr({ kind: "layout_conflict", message });
  }

  const iterationId = requestDocument.iteration_id;
  const workflowOperationId = requestDocument.workflow_operation_id;
  const ledgerOperationId = newIdOf(deps, "adopt-baseline");
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
    projectId: preview.project_id,
    repositoryId: preview.repository_id,
    iterationId,
    actor: "harness-scanner",
    timestamp: nowOf(deps),
  };
  const repositoryNode = scannedNodeRecord(context, {
    type: "Repository",
    locator: `repo://${preview.repository_id}`,
  });
  const nodes: NodeRecord[] = [repositoryNode];
  const edges = [
    edgeRecord(context, {
      type: "DERIVES_FROM",
      sourceId: iterationId,
      targetId: repositoryNode.id,
      source: "workflow",
    }),
  ];
  const componentIds = new Map<string, string>();
  for (const component of scan.components) {
    const componentNode = scannedNodeRecord(context, {
      type: "Component",
      locator: `repo://${preview.repository_id}/${component.path}`,
    });
    nodes.push(componentNode);
    componentIds.set(component.path, componentNode.id);
    edges.push(
      edgeRecord(context, {
        type: "CONTAINS",
        sourceId: repositoryNode.id,
        targetId: componentNode.id,
      }),
    );
  }
  for (const file of scan.files) {
    const nodeType = file.classification === "test" ? "Test" : "CodeArtifact";
    const fileNode = scannedNodeRecord(context, {
      type: nodeType,
      locator: `repo://${preview.repository_id}/${file.path}`,
      extensions: {
        "harness.scan": {
          classification: file.classification,
          sha256: file.sha256,
          size: file.size,
          ...(file.language === undefined ? {} : { language: file.language }),
        },
      },
    });
    nodes.push(fileNode);
    const slash = file.path.indexOf("/");
    const componentId = slash === -1 ? undefined : componentIds.get(file.path.slice(0, slash));
    edges.push(
      edgeRecord(context, {
        type: "CONTAINS",
        sourceId: repositoryNode.id,
        targetId: fileNode.id,
      }),
    );
    // Component membership follows the design relation matrix (design 8.3):
    // a CodeArtifact REALIZES its component; CONTAINS stays with the
    // Project/Repository/Iteration container nodes.
    if (componentId !== undefined && fileNode.type === "CodeArtifact") {
      edges.push(
        edgeRecord(context, {
          type: "REALIZES",
          sourceId: fileNode.id,
          targetId: componentId,
        }),
      );
    }
  }
  const iterationNode = iterationNodeRecord(
    { ...context, actor: "harness-bootstrap" },
    { iterationId, intent: requestDocument.intent },
  );
  nodes.push(iterationNode);

  const events = [
    lifecycleEvent(context, {
      eventId: newIdOf(deps, "event"),
      eventType: "OperationStarted",
      workflowOperationId,
      ledgerOperationId,
      sequence: 1,
      payload: { intent: requestDocument.intent, phase: "adopt_baseline" },
    }),
    lifecycleEvent(context, {
      eventId: newIdOf(deps, "event"),
      eventType: "OperationCompleted",
      workflowOperationId,
      ledgerOperationId,
      sequence: 2,
      payload: {
        approval_actor: request.approval.actor,
        outcome: "baseline_committed",
        phase: "adopt_baseline",
        preview_digest: previewDigest,
      },
    }),
  ];

  const ledger = new LedgerRepository({
    projectRoot,
    readBaseline: () => preview.baseline_commit,
    now: () => nowOf(deps),
  });
  try {
    await ledger.commit({
      ledger_operation_id: ledgerOperationId,
      workflow_operation_id: workflowOperationId,
      attempt_id: requestDocument.attempt_id,
      expected_baseline: preview.baseline_commit,
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
    message: "harness: record adoption baseline",
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
  discardStagedDocuments(projectRoot, request.stagingOperationId);

  return bootstrapOk({
    committed: true,
    rejected: false,
    projectRoot,
    repositoryId: preview.repository_id,
    repositoryNodeId: repositoryNode.id,
    iterationId,
    workflowOperationId,
    ledgerOperationId,
    baselineCommit: preview.baseline_commit,
    headCommit: recorded.value,
    branch,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  });
}
