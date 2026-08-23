import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import {
  createArtifactGraphView,
  createExecutionGraphView,
  materializeLedger,
  pageEdges,
  pageNodes,
  type GraphView,
} from "../../packages/graph/src/index.js";
import { harnessRootFor, resolveHarnessPath } from "../../packages/core/src/index.js";
import {
  renderPlanProjection,
  renderPrdProjection,
  type ProjectionDocument,
} from "../../adapters/projection-markdown/src/index.js";
import {
  ActionIntentJournal,
  ProjectionError,
  ToolError,
  ToolRegistry,
  buildProviderInstructionMirror,
  createDefaultGateSuite,
  detectProjectionDrift,
  invokeTool,
  normalizeGateDefinition,
  planManagedWrite,
  providerInstructionPath,
  reconcileJournal,
  writeManagedOutput,
  type GateDefinition,
  type ProviderInstructionMirror,
  type ToolInvocationRequest,
} from "../../packages/runtime/src/index.js";

import {
  approveAndResume,
  cleanupE2eRoots,
  git,
  makeHarness,
  makeTempDir,
  runJson,
  sequentialIds,
  type CliRun,
  type E2eHarness,
} from "./helpers.js";

/**
 * Cross-stack complete-loop assertions (plan Task 26). Every stack fixture
 * drives the same closed loop -- Requirement, both Graph Views, ImpactSet,
 * ExecutionPlan, ContextBundle, Run, Gate, Evaluation, Approval, Evidence,
 * Provider Projection and the final Snapshot -- plus the negative paths
 * (injected gate failure, invalid tool output, uncertain external action)
 * that must produce feedback and a blocked-resume, never silent upstream
 * rewrites. Node is the one declared host toolchain, so only the Node stack
 * runs its real pack-declared stack gate; Python and Java are covered at the
 * detection and scan level, as the plan's completion condition allows.
 */
export type StackName = "node" | "python" | "java";

export interface StackSpec {
  readonly stack: StackName;
  /** Absolute path of the committed fixture directory. */
  readonly fixtureDirectory: string;
  /** Pack name pinned into `.harness/harness.lock` on adopt. */
  readonly packName: string;
  readonly adoptIntent: string;
  readonly iterateIntent: string;
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function stackSpec(stack: StackName): StackSpec {
  return {
    stack,
    fixtureDirectory: join(REPO_ROOT, "fixtures", `${stack}-project`),
    packName: `pack-${stack}`,
    adoptIntent: `adopt the ${stack} fixture and deliver the first governed change`,
    iterateIntent: `deliver the follow-up ${stack} change`,
  };
}

interface PackManifest {
  readonly gates?: readonly unknown[];
  readonly templates?: { readonly provider_instruction?: string };
}

function readPackManifest(stack: StackName): PackManifest {
  const raw = readFileSync(join(REPO_ROOT, "packs", stack, "pack.json"), "utf8");
  return JSON.parse(raw) as PackManifest;
}

/** Canonical provider instruction template declared by the stack pack. */
export function packInstructionTemplate(stack: StackName): string {
  const template = readPackManifest(stack).templates?.provider_instruction;
  if (typeof template !== "string" || template === "") {
    throw new Error(`pack ${stack} declares no provider instruction template`);
  }
  return template;
}

export interface Session {
  readonly cwd: string;
  readonly runtime: E2eHarness["runtime"];
}

export { cleanupE2eRoots, git, makeTempDir, sequentialIds };

/** Copy the committed stack fixture into a fresh Git repository. */
export function makeFixtureRepo(spec: StackSpec): string {
  const parent = makeTempDir(`harness-e2e-${spec.stack}-`);
  const repo = join(parent, "repo");
  cpSync(spec.fixtureDirectory, repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Harness E2E");
  git(repo, "config", "user.email", "harness-e2e@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial commit");
  return repo;
}

/** Read the pack lock the adopt flow pinned into the managed layout. */
export function lockedPackNames(projectRoot: string): readonly string[] {
  const raw = readFileSync(join(projectRoot, ".harness", "harness.lock"), "utf8");
  const lock = JSON.parse(raw) as { readonly packs?: readonly { readonly name?: string }[] };
  return (lock.packs ?? []).map((pack) => pack.name ?? "");
}

function data(result: CliRun): Record<string, unknown> {
  return result.json["data"] as Record<string, unknown>;
}

/**
 * Drive approve/resume rounds until the operation leaves the approval state,
 * returning the terminal result and the approved object types in order.
 */
export async function drivePastApprovals(
  first: CliRun,
  session: Session,
): Promise<{ readonly result: CliRun; readonly approved: readonly string[] }> {
  const approved: string[] = [];
  let result = first;
  for (let step = 0; step < 8 && result.json["status"] === "approval_required"; step += 1) {
    approved.push(String(data(result)["object_type"]));
    result = await approveAndResume(result, session);
  }
  return { result, approved };
}

export interface AdoptLoopOutcome {
  readonly harness: E2eHarness;
  readonly session: Session;
  readonly result: CliRun;
  /** Approval object types seen after the staged baseline was approved. */
  readonly approved: readonly string[];
  readonly stagingPreview: Record<string, unknown>;
}

/**
 * Run `adopt` on a fixture repository through the full closed loop, asserting
 * stack detection and landing a completed Snapshot.
 */
export async function runAdoptLoop(
  spec: StackSpec,
  repo: string,
  newId: (kind: string) => string,
): Promise<AdoptLoopOutcome> {
  const harness = makeHarness(repo, newId);
  const session: Session = { cwd: repo, runtime: harness.runtime };

  let result = await runJson(
    ["adopt", ".", "--intent", spec.adoptIntent, "--profile", "lite"],
    session,
  );
  expect(result.json["status"]).toBe("approval_required");
  const preview = data(result);
  expect(preview["object_type"]).toBe("AdoptionBaseline");
  expect(preview["stack"]).toBe(spec.stack);
  expect(preview["files"] as number).toBeGreaterThan(0);
  expect(preview["components"] as number).toBeGreaterThan(0);
  expect(preview["conflicts"]).toBe(0);
  const stagingId = preview["staging_operation_id"] as string;

  result = await runJson(
    ["adopt", ".", "--intent", spec.adoptIntent, "--profile", "lite", "--approve", stagingId],
    session,
  );
  expect(lockedPackNames(repo)).toContain(spec.packName);
  const driven = await drivePastApprovals(result, session);
  expect(driven.result.json["status"]).toBe("ok");
  expect(typeof data(driven.result)["snapshot_id"]).toBe("string");
  return {
    harness,
    session,
    result: driven.result,
    approved: driven.approved,
    stagingPreview: preview,
  };
}

/** Non-empty sorted file listing of one committed artifact directory. */
export function artifactFiles(projectRoot: string, artifactDirectory: string): readonly string[] {
  const absolute = join(projectRoot, ".harness", ...artifactDirectory.split("/"));
  if (!existsSync(absolute)) {
    throw new Error(`expected committed artifact directory: ${artifactDirectory}`);
  }
  return readdirSync(absolute).sort();
}

function readJsonFile(absolute: string): Record<string, unknown> {
  return JSON.parse(readFileSync(absolute, "utf8")) as Record<string, unknown>;
}

function collectPageItems(view: GraphView): {
  readonly nodes: number;
  readonly edges: number;
} {
  let nodes = 0;
  let cursor: string | undefined;
  do {
    const page = view.pageNodes({ limit: 500, ...(cursor === undefined ? {} : { cursor }) });
    nodes += page.items.length;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  let edges = 0;
  let edgeCursor: string | undefined;
  do {
    const page = view.pageEdges({
      limit: 500,
      ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
    });
    edges += page.items.length;
    edgeCursor = page.nextCursor;
  } while (edgeCursor !== undefined);
  return { nodes, edges };
}

/** Both graph views materialize from the same authoritative ledger. */
export function assertGraphViews(projectRoot: string): void {
  const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const artifact = collectPageItems(createArtifactGraphView(database));
    const execution = collectPageItems(createExecutionGraphView(database));
    expect(artifact.nodes).toBeGreaterThan(0);
    expect(execution.nodes).toBeGreaterThan(0);
  } finally {
    database.close();
  }
}

/** Human projections rendered from the materialized authoritative ledger. */
export function renderHumanProjections(projectRoot: string): {
  readonly prd: ProjectionDocument;
  readonly plan: ProjectionDocument;
} {
  const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const nodes = [];
    let cursor: string | undefined;
    do {
      const page = pageNodes(database, { limit: 500, ...(cursor === undefined ? {} : { cursor }) });
      nodes.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const edges = [];
    let edgeCursor: string | undefined;
    do {
      const page = pageEdges(database, {
        limit: 500,
        ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
      });
      edges.push(...page.items);
      edgeCursor = page.nextCursor;
    } while (edgeCursor !== undefined);
    return {
      prd: renderPrdProjection({ nodes, edges }),
      plan: renderPlanProjection({ nodes, edges }),
    };
  } finally {
    database.close();
  }
}

/** Deterministic provider mirror generated from the canonical pack template. */
export function buildProjectMirror(
  spec: StackSpec,
  harness: E2eHarness,
): ProviderInstructionMirror {
  const envelope = harness.executorCalls.at(-1);
  if (envelope === undefined) throw new Error("the closed loop recorded no task envelope");
  return buildProviderInstructionMirror({
    provider: "e2e-agent",
    instruction: packInstructionTemplate(spec.stack),
    task_envelope_digest: envelope.digest,
    context_bundle_digest: envelope.context_bundle_digest,
  });
}

/**
 * Provider projection battery: a pre-seeded user provider configuration is
 * never overwritten without an explicit overwrite approval; the approved
 * regeneration converges to the deterministic mirror with no drift. The
 * managed mirror file is removed afterwards so the worktree stays clean.
 */
export function assertProviderProjection(
  projectRoot: string,
  spec: StackSpec,
  harness: E2eHarness,
): string {
  const harnessRoot = harnessRootFor(projectRoot);
  const mirror = buildProjectMirror(spec, harness);
  const mirrorPath = providerInstructionPath(mirror.provider);
  const absolute = resolveHarnessPath(harnessRoot, mirrorPath);

  // Pre-seeded user provider configuration: the managed write previews a
  // rewrite of foreign bytes and is refused without an explicit approval.
  mkdirSync(dirname(absolute), { recursive: true });
  const userConfiguration = "# user-managed provider configuration\n";
  writeFileSync(absolute, userConfiguration, "utf8");
  const plan = planManagedWrite(harnessRoot, mirror.output);
  expect(plan.action).toBe("rewrite");
  let refusal: unknown;
  try {
    writeManagedOutput(harnessRoot, mirror.output);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(ProjectionError);
  expect((refusal as ProjectionError).kind).toBe("unapproved_overwrite");
  expect(readFileSync(absolute, "utf8")).toBe(userConfiguration);

  // Approved regeneration converges to the deterministic, drift-free mirror.
  const written = writeManagedOutput(harnessRoot, mirror.output, { overwriteApproved: true });
  expect(written.digest).toBe(mirror.digest);
  const drift = detectProjectionDrift(harnessRoot, {
    path: mirrorPath,
    expectedDigest: mirror.digest,
  });
  expect(drift.status).toBe("current");

  rmSync(absolute, { force: true });
  return mirror.digest;
}

export interface CompleteLoopOptions {
  /** Intent fragment the PRD projection must render. */
  readonly intentFragment: string;
  /** Extra gate ids (beyond gate_ledger_integrity) with committed evidence. */
  readonly extraGateIds?: readonly string[];
}

/**
 * The full closed-loop artifact battery (plan Task 26 step 3, T9 Lite
 * profile): Requirement, both Graph Views, ExecutionPlan, ContextBundle, Run,
 * Gate, Approval, Evidence, human projections and the final Snapshot — and
 * the mechanical proof that the kernel-only loop writes zero module
 * artifacts (no ImpactSet, no Evaluation) and zero model invocations.
 * The Provider Projection battery runs separately via
 * `assertProviderProjection`.
 */
export async function assertCompleteLoopArtifacts(
  projectRoot: string,
  session: Session,
  harness: E2eHarness,
  options: CompleteLoopOptions,
): Promise<void> {
  // Requirement capture: intent and requirement artifacts are committed.
  expect(artifactFiles(projectRoot, "artifacts/intents").length).toBeGreaterThan(0);
  expect(artifactFiles(projectRoot, "artifacts/requirements").length).toBeGreaterThan(0);
  // T9 Lite: zero module or model artifacts — the directories never exist.
  for (const absent of [
    "artifacts/impact-sets",
    "artifacts/evaluations",
    "artifacts/model-invocations",
    "artifacts/model-provider-bindings",
  ]) {
    expect(existsSync(join(projectRoot, ".harness", absent)), `${absent} must not exist`).toBe(
      false,
    );
  }
  // ExecutionPlan and ContextBundle.
  expect(artifactFiles(projectRoot, "artifacts/plans").length).toBeGreaterThan(0);
  const bundles = artifactFiles(projectRoot, "artifacts/context-bundles");
  expect(bundles.length).toBeGreaterThan(0);
  const envelope = harness.executorCalls.at(-1);
  if (envelope === undefined) throw new Error("the closed loop recorded no task envelope");
  expect(bundles).toContain(`${envelope.context_bundle_id}.json`);
  // Run artifacts (T9 Lite: kernel verdicts need no evaluation records).
  expect(artifactFiles(projectRoot, "artifacts/runs").length).toBeGreaterThan(0);
  // Gate evidence: the universal ledger integrity gate plus injected extras.
  expect(
    artifactFiles(projectRoot, "artifacts/evidence/evidence_ledger_integrity").length,
  ).toBeGreaterThan(0);
  for (const gateId of options.extraGateIds ?? []) {
    const evidenceId = `evidence_${gateId.slice("gate_".length)}`;
    expect(artifactFiles(projectRoot, `artifacts/evidence/${evidenceId}`).length).toBeGreaterThan(
      0,
    );
  }
  // Approval authority: deterministic low-risk Lite Capture auto-accepts the
  // requirement baseline, while execution remains explicitly authorized;
  // never a module object in Lite.
  expect(artifactFiles(projectRoot, "artifacts/approval-requests").length).toBeGreaterThanOrEqual(
    1,
  );
  expect(artifactFiles(projectRoot, "artifacts/approvals").length).toBeGreaterThanOrEqual(1);
  // Final Snapshot: completed, evidence-bearing and bound to a real commit of
  // the project history (HEAD itself may be one later bookkeeping commit).
  expect(artifactFiles(projectRoot, "artifacts/snapshots").length).toBeGreaterThan(0);
  const snapshot = await runJson(["snapshot"], session);
  expect(snapshot.json["status"]).toBe("ok");
  const snapshotData = data(snapshot);
  expect(snapshotData["status"]).toBe("completed");
  expect((snapshotData["evidence"] as readonly unknown[]).length).toBeGreaterThan(0);
  const sourceCommit = snapshotData["source_commit"] as string;
  const ledgerCommit = snapshotData["ledger_commit"] as string;
  expect(sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
  expect(ledgerCommit).toMatch(/^[0-9a-f]{40}$/u);
  expect(snapshotData["repository_head"]).toBe(git(projectRoot, "rev-parse", "HEAD").trim());
  expect(snapshotData["final_commit"]).toBeUndefined();
  expect(() => git(projectRoot, "merge-base", "--is-ancestor", sourceCommit, "HEAD")).not.toThrow();
  // Both graph views materialize from the same authoritative ledger.
  assertGraphViews(projectRoot);
  // Human projections render the captured intent and the execution plan.
  const projections = renderHumanProjections(projectRoot);
  expect(projections.prd.markdown).toContain(options.intentFragment);
  expect(projections.plan.markdown).toContain("# Execution Plan");
}

const PROBE_GATE_ID = "gate_injected_probe";
const PROBE_FINDING_DIRECTORY = "finding_injected_probe";

function gateOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      exit_code: { type: "integer" },
      summary: { type: "string" },
      log_summary: { type: "string" },
      artifacts: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["exit_code"],
    additionalProperties: false,
  };
}

function probeToolDescriptor(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "injected_probe",
    version: "1.0.0",
    description: "E2E injected verification probe",
    input_schema: { type: "object", additionalProperties: false },
    output_schema: gateOutputSchema(),
    allowed_phases: ["verification"],
    resource_patterns: [],
    risk: "low",
    side_effect_class: "none",
    requires_approval: false,
    timeout_ms: 30000,
    retry_class: "none",
    max_retries: 0,
    max_invocations_per_run: 50,
    idempotent: true,
    reconciliation: "provider",
    ...overrides,
  };
}

function probeGateDefinition(): GateDefinition {
  return normalizeGateDefinition({
    gate_id: PROBE_GATE_ID,
    layer: "project",
    name: "injected probe",
    mandatory: true,
    subject_id: "probe_injected",
    tool: "injected_probe",
  });
}

export interface InjectedGateSuite {
  readonly gates: readonly GateDefinition[];
  readonly toolRegistry: ToolRegistry;
}

/** Mandatory project gate that fails until the test flips it to pass. */
export function createFailingGateSuite(projectRoot: string): InjectedGateSuite & {
  readonly setMode: (mode: "fail" | "pass") => void;
} {
  let mode: "fail" | "pass" = "fail";
  const base = createDefaultGateSuite(projectRoot);
  base.registry.register(probeToolDescriptor({}), () =>
    mode === "fail"
      ? {
          exit_code: 1,
          summary: "injected probe gate failed",
          log_summary: "probe output",
          artifacts: {},
        }
      : {
          exit_code: 0,
          summary: "injected probe gate passed",
          log_summary: "probe output",
          artifacts: {},
        },
  );
  return {
    gates: [...base.gates, probeGateDefinition()],
    toolRegistry: base.registry,
    setMode: (next) => {
      mode = next;
    },
  };
}

/** Mandatory project gate whose tool returns schema-violating output at first. */
export function createInvalidOutputGateSuite(projectRoot: string): InjectedGateSuite & {
  readonly setMode: (mode: "invalid" | "valid") => void;
} {
  let mode: "invalid" | "valid" = "invalid";
  const base = createDefaultGateSuite(projectRoot);
  base.registry.register(probeToolDescriptor({}), () =>
    mode === "invalid"
      ? { unexpected: true }
      : {
          exit_code: 0,
          summary: "injected probe gate passed",
          log_summary: "probe output",
          artifacts: {},
        },
  );
  return {
    gates: [...base.gates, probeGateDefinition()],
    toolRegistry: base.registry,
    setMode: (next) => {
      mode = next;
    },
  };
}

function runNodeTestSuite(projectRoot: string): Record<string, unknown> {
  // Bare `node --test` uses the built-in default discovery (the `test`
  // directory and `*.test.js` files); passing the directory itself is not
  // portable across supported Node versions.
  const result = spawnSync(process.execPath, ["--test"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const exitCode = result.status ?? 1;
  const output = `${result.stdout}${result.stderr}`.trim().split("\n");
  return {
    exit_code: exitCode,
    summary: exitCode === 0 ? "node --test passed" : "node --test failed",
    log_summary: output.slice(-5).join("\n"),
    artifacts: {},
  };
}

/**
 * The Node pack's declared mandatory stack gate, executed for real through
 * the Tool Registry against the adopted fixture. Node is the one host
 * toolchain the E2E suite may assume (plan Task 26 constraint).
 */
export function createNodeStackGateSuite(projectRoot: string): InjectedGateSuite {
  const base = createDefaultGateSuite(projectRoot);
  base.registry.register(
    probeToolDescriptor({ name: "node_test", description: "run the project node:test suite" }),
    () => runNodeTestSuite(projectRoot),
  );
  const declared = (readPackManifest("node").gates ?? []).find(
    (gate) => (gate as { readonly gate_id?: string }).gate_id === "gate_node_test",
  );
  if (declared === undefined) throw new Error("node pack declares no gate_node_test gate");
  return { gates: [...base.gates, normalizeGateDefinition(declared)], toolRegistry: base.registry };
}

const REPAIR_TARGETS: Readonly<
  Record<StackName, { readonly path: string; readonly prefix: string }>
> = {
  node: { path: "src/greeting.js", prefix: "//" },
  python: { path: "src/greeting.py", prefix: "#" },
  java: { path: "src/main/java/example/Greeting.java", prefix: "//" },
};

/**
 * A deterministic in-band repair: one uncommitted comment line changes the
 * worktree code digest, so the verify phase re-runs instead of replaying the
 * failed verdict. The repair stays uncommitted until the blocked operation
 * resumes; after the gates pass, Harness anchors the Agent-declared source
 * path in the completed iteration's source commit.
 */
export function repairFixtureSource(spec: StackSpec, projectRoot: string, tag: string): void {
  const target = REPAIR_TARGETS[spec.stack];
  const absolute = join(projectRoot, ...target.path.split("/"));
  appendFileSync(absolute, `${target.prefix} repair ${tag}\n`, "utf8");
}

async function runBlockedResumeScenario(
  spec: StackSpec,
  projectRoot: string,
  newId: (kind: string) => string,
  suite: InjectedGateSuite,
  tag: string,
  findingSummaryFragment: string,
  repair: () => void,
): Promise<void> {
  const harness = makeHarness(projectRoot, newId, {
    gates: suite.gates,
    toolRegistry: suite.toolRegistry,
    reportedSourcePaths: [REPAIR_TARGETS[spec.stack].path],
  });
  const session: Session = { cwd: projectRoot, runtime: harness.runtime };

  const started = await runJson(["iterate", `${spec.iterateIntent} (${tag})`], session);
  const driven = await drivePastApprovals(started, session);
  const blocked = driven.result;
  expect(blocked.json["status"]).toBe("blocked");
  const blockedData = data(blocked);
  expect(blockedData["reason"]).toBe("repairable_gate_failure");
  expect(typeof blockedData["resume_command"]).toBe("string");
  const workflowOperationId = blockedData["workflow_operation_id"] as string;

  // Feedback: a proposed Finding and a blocked Snapshot -- never a silent
  // rewrite of the upstream Requirement or Decision artifacts.
  const findingDirectory = join(
    projectRoot,
    ".harness",
    "artifacts",
    "findings",
    PROBE_FINDING_DIRECTORY,
  );
  const proposed = readJsonFile(join(findingDirectory, "proposed.json"));
  expect(proposed["status"]).toBe("proposed");
  expect(String(proposed["summary"])).toContain(findingSummaryFragment);
  const blockedSnapshot = readJsonFile(
    join(
      projectRoot,
      ".harness",
      "artifacts",
      "snapshots",
      `${blockedData["snapshot_id"] as string}.json`,
    ),
  );
  expect(blockedSnapshot["status"]).toBe("blocked");
  expect(blockedSnapshot["resume_phase"]).toBe("verify");

  // Repair, then resume: the gate re-runs against the new code binding, the
  // finding closes with current evidence, and the declared repair path lands
  // in the source commit before the completed Snapshot is written.
  repairFixtureSource(spec, projectRoot, tag);
  repair();
  const resumed = await runJson(["resume", workflowOperationId], session);
  expect(resumed.json["status"], JSON.stringify(resumed.json)).toBe("ok");
  const resumedData = data(resumed);
  expect(typeof resumedData["snapshot_id"]).toBe("string");
  const sourceCommit = resumedData["source_commit"] as string;
  expect(sourceCommit).toMatch(/^[a-f0-9]{40,64}$/u);
  expect(git(projectRoot, "show", `${sourceCommit}:${REPAIR_TARGETS[spec.stack].path}`)).toContain(
    `repair ${tag}`,
  );
  expect(resumedData["ledger_commit"]).toBe(resumedData["repository_head"]);
  expect(resumedData["final_commit"]).toBeUndefined();
  const closed = readJsonFile(join(findingDirectory, "closed.json"));
  expect(closed["status"]).toBe("closed");
}

/**
 * Injected gate failure: the mandatory project gate fails, the loop records
 * feedback and blocks with a resume command, and a repair plus resume closes
 * the finding and completes the Snapshot.
 */
export async function assertGateFailureFeedbackAndResume(
  spec: StackSpec,
  projectRoot: string,
  newId: (kind: string) => string,
): Promise<void> {
  const suite = createFailingGateSuite(projectRoot);
  await runBlockedResumeScenario(
    spec,
    projectRoot,
    newId,
    suite,
    "gate-failure",
    PROBE_GATE_ID,
    () => suite.setMode("pass"),
  );
}

/**
 * Invalid tool output: the gate tool's schema-violating output fails the gate
 * with a typed `invalid_output` error; the same feedback and blocked-resume
 * contract holds.
 */
export async function assertInvalidToolOutputFeedbackAndResume(
  spec: StackSpec,
  projectRoot: string,
  newId: (kind: string) => string,
): Promise<void> {
  const suite = createInvalidOutputGateSuite(projectRoot);
  await runBlockedResumeScenario(
    spec,
    projectRoot,
    newId,
    suite,
    "invalid-output",
    "invalid_output",
    () => suite.setMode("valid"),
  );
}

/**
 * Uncertain external action: a side effect whose outcome cannot be observed
 * stays uncertain; a blind retry is blocked with typed feedback, and resume
 * goes through reconciliation -- the proven effect is reused, never replayed.
 */
export async function assertUncertainExternalActionFeedback(): Promise<void> {
  const applied: string[] = [];
  const journal = new ActionIntentJournal();
  const registry = new ToolRegistry();
  registry.register(
    probeToolDescriptor({
      name: "e2e_external_probe",
      description: "E2E external probe whose outcome may be unobservable",
      resource_patterns: ["probe:*"],
      risk: "high",
      side_effect_class: "external",
      timeout_ms: 10,
      max_invocations_per_run: 10,
    }),
    () => {
      applied.push("probe:1");
      // The provider applies the effect, then the observation channel hangs.
      return new Promise(() => undefined);
    },
  );
  const validateApproval = (): boolean => true;
  const request: ToolInvocationRequest = {
    intent_id: "intent_e2e_uncertain",
    tool: "e2e_external_probe",
    phase: "verification",
    resource: "probe:1",
    parameters: {},
    idempotency_key: "e2e-op-1",
  };
  const call = async (intentId: string): Promise<ToolError> => {
    try {
      await invokeTool(
        registry,
        { ...request, intent_id: intentId },
        { journal, validateApproval },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      return error as ToolError;
    }
    throw new Error("expected the external probe call to fail");
  };

  const failure = await call("intent_e2e_uncertain");
  expect(failure.kind).toBe("uncertain_result");
  expect(applied).toEqual(["probe:1"]);
  expect(journal.get("intent_e2e_uncertain")?.status).toBe("uncertain");

  // Blocked: a blind retry of an unresolved key is refused with feedback.
  const blindRetry = await call("intent_e2e_retry");
  expect(blindRetry.kind).toBe("reconciliation_required");
  expect(applied).toEqual(["probe:1"]);

  // Resume reconciles: the proven effect is reused, never re-applied.
  const decisions = await reconcileJournal(journal, registry, () => "applied");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]?.decision).toBe("reuse_result");
  const intent = journal.get("intent_e2e_uncertain");
  if (intent === undefined) throw new Error("uncertain intent missing from the journal");
  journal.markReconciledApplied(intent);
  const replayed = await invokeTool(
    registry,
    { ...request, intent_id: "intent_e2e_reuse" },
    { journal, validateApproval },
  );
  expect(replayed.replayed).toBe(true);
  expect(applied).toEqual(["probe:1"]);
}

/**
 * Normalized ledger view for cross-run comparison: every file under the
 * managed `.harness` root, keyed by POSIX relative path, with the absolute
 * project root scrubbed. Every cache (SQLite, live event spool, semantic
 * index) is disposable and non-authoritative, so the whole cache subtree is
 * excluded from deterministic Ledger comparisons.
 */
export function normalizedLedger(projectRoot: string): Readonly<Record<string, string>> {
  const harnessRoot = join(projectRoot, ".harness");
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativeEntry = relative(harnessRoot, absolute).split(sep).join("/");
      if (
        entry.isDirectory() &&
        (relativeEntry === "cache" || relativeEntry.startsWith("cache/"))
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const key = relative(harnessRoot, absolute).split(sep).join("/");
      files[key] = readFileSync(absolute, "utf8").split(projectRoot).join("<project-root>");
    }
  };
  walk(harnessRoot);
  return files;
}

export interface DeterministicRunRecord {
  readonly normalizedLedger: Readonly<Record<string, string>>;
  readonly prdDigest: string;
  readonly planDigest: string;
  readonly mirrorDigest: string;
}

/**
 * Clone the prepared fixture repository into a fresh directory and run the
 * full adopt loop there, collecting the normalized ledger, the human
 * projection digests and the provider mirror digest for comparison.
 */
export async function runCleanCloneAdopt(
  spec: StackSpec,
  sourceRepo: string,
): Promise<DeterministicRunRecord> {
  const parent = makeTempDir(`harness-e2e-${spec.stack}-clone-`);
  const clone = join(parent, "clone");
  execGitClone(sourceRepo, clone);
  const newId = sequentialIds();
  const loop = await runAdoptLoop(spec, clone, newId);
  const projections = renderHumanProjections(clone);
  const mirrorDigest = assertProviderProjection(clone, spec, loop.harness);
  return {
    normalizedLedger: normalizedLedger(clone),
    prdDigest: projections.prd.generation_digest,
    planDigest: projections.plan.generation_digest,
    mirrorDigest,
  };
}

function execGitClone(source: string, destination: string): void {
  git(dirname(destination), "clone", "--quiet", source, destination);
}
