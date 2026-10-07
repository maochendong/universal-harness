import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  readCommittedOperations,
  sha256Hex,
} from "@universal-harness-internal/core";
import { readImpactSetContent } from "@universal-harness-internal/graph";
import {
  createGenericInterpreter,
  createNewProject,
  readApprovalRequests,
  resolveApproval,
  resumeIteration,
  runIteration,
  WorkflowEngine,
  type OrchestratorDependencies,
} from "../../src/index.js";
import { createJevImpactAdvisoryPort } from "../../src/model/jev-impact-adapter.js";
import { createJevImpactProviderFactory } from "../../src/model/jev-impact-provider.js";
import { readModelInvocationRecords } from "../../src/model/invocation-store.js";
import {
  commitArtifacts,
  materializeProjectGraph,
} from "../../src/orchestration/kernel-coordinator.js";
import { jevNode, jevRegistry } from "../model/jev-fixtures.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

afterEach(cleanupDirectories);
const INTENT = "Ship a CSV export for the monthly report.";

async function fixture(
  options: {
    choice?: "affected" | "unrelated" | "insufficient";
    candidate?: boolean;
    enabled?: boolean;
    failFirst?: boolean;
    unsupported?: boolean;
  } = {},
) {
  const newId = sequentialIds();
  const vcs = createGitVcsAdapter();
  const created = await createNewProject(
    { parentDirectory: makeTempDir("harness-jev-pipe-"), name: "jev-loop", intent: INTENT },
    { vcs, now: () => FIXED_NOW, newId },
  );
  if (!created.ok) throw new Error(created.error.message);
  const projectRoot = created.value.projectRoot;
  const choice = options.choice ?? "affected";
  let calls = 0;
  const fetchMock = vi.fn<typeof fetch>(async () => {
    calls += 1;
    if (options.failFirst && calls === 1) return new Response("unavailable", { status: 503 });
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          requirement_consumer: {
            type: "choice",
            choice,
            probabilities: {
              affected: choice === "affected" ? 0.9 : 0.05,
              unrelated: choice === "unrelated" ? 0.9 : 0.05,
              insufficient: choice === "insufficient" ? 0.9 : 0.05,
            },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 300, output_tokens: 20 },
      }),
    );
  });
  const deps: OrchestratorDependencies = {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    vcs,
    now: () => FIXED_NOW,
    newId,
    interpret: createGenericInterpreter(),
    ...(options.enabled === false
      ? {}
      : {
          impactAdvisory: createJevImpactAdvisoryPort({
            projectRoot,
            registry: jevRegistry(),
            profile_id: "lite",
            provider_config: {
              provider_identity: "provider_typesafe",
              config_digest: "c".repeat(64),
              budget_profile: "managed-lite",
            },
            provider_factory: createJevImpactProviderFactory({
              fetch: fetchMock,
              ambientEnvironment: { TYPESAFE_API_KEY: "fake" },
            }),
          }),
        }),
  };
  const first = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
  if (first.status !== "approval_required")
    throw new Error(`expected baseline approval, got ${first.status}`);
  await resolveApproval(deps, {
    requestId: first.required.request_id,
    decision: "approve",
    actor: "human:test-reviewer",
  });
  const workflowId = first.required.workflow_operation_id;
  const engine = new WorkflowEngine(deps);
  if (options.candidate !== false) {
    const candidate = jevNode(
      "requirement_consumer",
      options.unsupported ? { type: "CodeArtifact" } : {},
    );
    await commitArtifacts(deps, workflowId, engine.getOperation(workflowId)!.attempt_id, [
      {
        path: "artifacts/requirements/jev-consumer.json",
        content: `${canonicalizeJson(candidate)}\n`,
      },
    ]);
  }
  return { deps, projectRoot, workflowId, engine, fetchMock };
}

function impactRequests(projectRoot: string, workflowId: string) {
  return readApprovalRequests(
    harnessRootFor(projectRoot),
    readCommittedOperations(harnessRootFor(projectRoot)),
    workflowId,
  ).filter((request) => request.object_type === "ImpactSet");
}

describe("Jev real Impact pipeline with mock HTTP", { timeout: 90000 }, () => {
  it.each(["affected", "unrelated"] as const)(
    "%s still requires whole ImpactSet approval and freezes only afterwards",
    async (choice) => {
      const { deps, projectRoot, workflowId, fetchMock } = await fixture({ choice });
      const outcome = await resumeIteration(deps, workflowId, undefined);
      expect(outcome.status).toBe("approval_required");
      if (outcome.status !== "approval_required") throw new Error("expected impact approval");
      expect(outcome.required.object_type).toBe("ImpactSet");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(readModelInvocationRecords(projectRoot).at(-1)?.state).toBe("consumed");
      const root = harnessRootFor(projectRoot);
      const diagnosticDir = join(root, "diagnostics/impact-advisory");
      const diagnostic = readFileSync(join(diagnosticDir, readdirSync(diagnosticDir)[0]!), "utf8");
      expect(JSON.parse(diagnostic)).toMatchObject({
        code: "candidate_scope",
        candidate_count: 1,
        excluded_by_reason: {
          already_deterministic: expect.any(Number),
          not_accepted: expect.any(Number),
          unsupported_type: expect.any(Number),
        },
      });
      expect(
        readCommittedOperations(root).some((operation) =>
          operation.manifest.artifact_digests.includes(sha256Hex(diagnostic)),
        ),
      ).toBe(true);
      const graph = materializeProjectGraph(projectRoot);
      try {
        expect(
          graph.nodes.filter((node) => node.type === "ImpactSet" && node.status === "accepted"),
        ).toHaveLength(0);
      } finally {
        graph.close();
      }
      await resolveApproval(deps, {
        requestId: outcome.required.request_id,
        decision: "approve",
        actor: "human:test-reviewer",
      });
      const completed = await resumeIteration(deps, workflowId, {
        intent: "",
        untilPhase: "impact",
      });
      expect(completed.status).toBe("advanced");
      const frozenGraph = materializeProjectGraph(projectRoot);
      try {
        const frozen = frozenGraph.nodes.find(
          (node) => node.type === "ImpactSet" && node.status === "accepted",
        );
        expect(frozen).toBeDefined();
        expect(
          readImpactSetContent(frozen!).entries.some(
            (entry) => entry.node_id === "requirement_consumer",
          ),
        ).toBe(choice === "affected");
      } finally {
        frozenGraph.close();
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("insufficient blocks without an ImpactSet approval or frozen result", async () => {
    const { deps, projectRoot, workflowId, fetchMock } = await fixture({ choice: "insufficient" });
    expect(await resumeIteration(deps, workflowId, undefined)).toMatchObject({
      status: "blocked",
      reason: "missing_input",
    });
    expect(impactRequests(projectRoot, workflowId)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed HTTP attempt blocks, explicit resume retains history and clears only owned blockers", async () => {
    const { deps, projectRoot, workflowId, engine, fetchMock } = await fixture({ failFirst: true });
    await engine.commitCheckpoint(workflowId, {
      boundary: "task",
      proposal: {
        add_blockers: ["[other-module] keep"],
        add_open_questions: ["Keep this unrelated question"],
      },
    });
    expect(await resumeIteration(deps, workflowId, undefined)).toMatchObject({ status: "blocked" });
    expect(impactRequests(projectRoot, workflowId)).toHaveLength(0);
    expect(
      engine
        .getWorkingState(workflowId)!
        .blockers.some((blocker) => blocker.startsWith("[impact-advisory:")),
    ).toBe(true);
    const failed = readModelInvocationRecords(projectRoot).filter(
      (record) => record.state === "failed",
    );
    expect(failed).toHaveLength(1);
    expect(await resumeIteration(deps, workflowId, undefined)).toMatchObject({
      status: "approval_required",
    });
    const state = engine.getWorkingState(workflowId)!;
    expect(state.blockers).toContain("[other-module] keep");
    expect(state.blockers.some((blocker) => blocker.startsWith("[impact-advisory:"))).toBe(false);
    expect(state.open_questions).toEqual(["Keep this unrelated question"]);
    const records = readModelInvocationRecords(projectRoot);
    expect(records).toContainEqual(failed[0]);
    expect(
      new Set(
        records
          .filter((record) => record.state === "planned")
          .map((record) => record.invocation_id),
      ).size,
    ).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("zero candidates commits a local diagnostic atomically with the proposed set, without a fake invocation", async () => {
    const { deps, projectRoot, workflowId, fetchMock } = await fixture({ candidate: false });
    const approval = await resumeIteration(deps, workflowId, undefined);
    expect(approval).toMatchObject({
      status: "approval_required",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readModelInvocationRecords(projectRoot)).toHaveLength(0);
    const root = harnessRootFor(projectRoot);
    const dir = join(root, "diagnostics/impact-advisory");
    const diagnostic = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(JSON.parse(diagnostic)).toMatchObject({ code: "no_candidates", candidate_count: 0 });
    const graph = materializeProjectGraph(projectRoot);
    try {
      const proposed = graph.nodes.find((node) => node.type === "ImpactSet")!;
      const proposedBytes = readFileSync(
        join(root, `artifacts/impact-sets/${proposed.id}/1.json`),
        "utf8",
      );
      expect(
        readCommittedOperations(root).some(
          (operation) =>
            operation.manifest.artifact_digests.includes(sha256Hex(diagnostic)) &&
            operation.manifest.artifact_digests.includes(sha256Hex(proposedBytes)),
        ),
      ).toBe(true);
    } finally {
      graph.close();
    }
    if (approval.status !== "approval_required") throw new Error("expected Impact approval");
    await resolveApproval(deps, {
      requestId: approval.required.request_id,
      decision: "approve",
      actor: "human:test-reviewer",
    });
    await resumeIteration(deps, workflowId, { intent: "", untilPhase: "impact" });
    // A new attempt has its own diagnostic even though the proposed revision exists.
    expect(readdirSync(dir)).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readModelInvocationRecords(projectRoot)).toHaveLength(0);
  });

  it("unsupported projection explains a configuration switch and does not keep retrying the provider", async () => {
    const { deps, projectRoot, workflowId, engine, fetchMock } = await fixture({
      unsupported: true,
    });
    expect(await resumeIteration(deps, workflowId, undefined)).toMatchObject({
      status: "blocked",
      detail: expect.stringContaining("切回原生成式 Adapter"),
    });
    expect(await resumeIteration(deps, workflowId, undefined)).toMatchObject({ status: "blocked" });
    expect(impactRequests(projectRoot, workflowId)).toHaveLength(0);
    expect(
      engine
        .getWorkingState(workflowId)!
        .blockers.filter((value) => value.startsWith("[impact-advisory:")).length,
    ).toBe(1);
    const { impactAdvisory: _advisory, ...withoutAdvisory } = deps;
    expect(_advisory).toBeDefined();
    expect(await resumeIteration(withoutAdvisory, workflowId, undefined)).toMatchObject({
      status: "approval_required",
    });
    expect(
      engine
        .getWorkingState(workflowId)!
        .blockers.some((value) => value.startsWith("[impact-advisory:")),
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readModelInvocationRecords(projectRoot)).toHaveLength(0);
  });

  it("recovers orphaned proposed and diagnostic bytes after a pre-manifest crash", async () => {
    const { deps, projectRoot, workflowId, fetchMock } = await fixture({ candidate: false });
    const crash = new Error("simulated diagnostic publish crash");
    await expect(
      resumeIteration(
        {
          ...deps,
          hooks: {
            atBoundary(boundary, context) {
              if (
                boundary === "shards.renamed" &&
                context.targetFiles.some((path) => path.includes("/diagnostics/impact-advisory/"))
              )
                throw crash;
            },
          },
        },
        workflowId,
        undefined,
      ),
    ).rejects.toBe(crash);
    const root = harnessRootFor(projectRoot);
    const directory = join(root, "diagnostics/impact-advisory");
    expect(existsSync(directory)).toBe(true);
    const path = join(directory, readdirSync(directory)[0]!);
    const raw = readFileSync(path, "utf8");
    const digest = sha256Hex(raw);
    expect(
      readCommittedOperations(root).some((operation) =>
        operation.manifest.artifact_digests.includes(digest),
      ),
    ).toBe(false);
    expect(await resumeIteration(deps, workflowId, undefined)).toMatchObject({
      status: "approval_required",
    });
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(
      readCommittedOperations(root).some((operation) =>
        operation.manifest.artifact_digests.includes(digest),
      ),
    ).toBe(true);
    const graph = materializeProjectGraph(projectRoot);
    try {
      expect(graph.nodes.some((node) => node.type === "ImpactSet")).toBe(true);
    } finally {
      graph.close();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readModelInvocationRecords(projectRoot)).toHaveLength(0);
  });

  it("an unconfigured Lite/legacy path remains deterministic with no model invocation", async () => {
    const { deps, projectRoot, workflowId, fetchMock } = await fixture({ enabled: false });
    expect(await resumeIteration(deps, workflowId, undefined)).toMatchObject({
      status: "approval_required",
    });
    expect(readModelInvocationRecords(projectRoot)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses orphan business content tampering even with a valid outer node digest", async () => {
    const { deps, projectRoot, workflowId } = await fixture({ candidate: false });
    let proposedPath = "";
    await expect(
      resumeIteration(
        {
          ...deps,
          hooks: {
            atBoundary(boundary, context) {
              if (
                boundary === "shards.renamed" &&
                context.targetFiles.some((path) => path.includes("/diagnostics/impact-advisory/"))
              ) {
                proposedPath = context.targetFiles.find((path) =>
                  path.includes("/artifacts/impact-sets/"),
                )!;
                throw new Error("crash before manifest");
              }
            },
          },
        },
        workflowId,
        undefined,
      ),
    ).rejects.toThrow("crash before manifest");
    const { digest: oldDigest, ...record } = JSON.parse(readFileSync(proposedPath, "utf8"));
    expect(oldDigest).toMatch(/^[a-f0-9]{64}$/);
    record.extensions["harness.impact"].entries = [];
    writeFileSync(
      proposedPath,
      `${canonicalizeJson({ ...record, digest: contentDigest(record) })}\n`,
    );
    expect(await resumeIteration(deps, workflowId, undefined)).toMatchObject({
      status: "blocked",
      reason: "stale_evidence",
    });
    expect(impactRequests(projectRoot, workflowId)).toHaveLength(0);
  });

  it("does not persist sensitive clarification text into the blocker or WorkingState", async () => {
    const { deps, projectRoot, workflowId, engine, fetchMock } = await fixture();
    const privatePath = ["", "Users", "fixture-user", "private"].join("/");
    const outcome = await resumeIteration(
      {
        ...deps,
        impactAdvisory: {
          name: "unsafe-clarification-fixture",
          advise: async () => ({
            status: "clarification_required",
            questions: [{ question: `Read ${privatePath} before approval` }],
          }),
        },
      },
      workflowId,
      undefined,
    );
    expect(outcome).toMatchObject({ status: "blocked", detail: expect.stringContaining("未展示") });
    expect(JSON.stringify(outcome)).not.toContain(privatePath);
    expect(JSON.stringify(engine.getWorkingState(workflowId))).not.toContain(privatePath);
    expect(impactRequests(projectRoot, workflowId)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
