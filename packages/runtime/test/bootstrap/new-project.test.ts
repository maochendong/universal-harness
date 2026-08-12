import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LedgerRepository, readManagedManifest } from "@universal-harness-internal/core";
import type { VcsAdapter, VcsResult, RepositoryInfo } from "@universal-harness-internal/plugin-sdk";

import { createNewProject, createRuntimeService } from "../../src/index.js";
import { FIXED_NOW, cleanupDirectories, git, headOf, makeDeps, makeTempDir } from "./helpers.js";

afterEach(cleanupDirectories);

function harnessFiles(projectRoot: string): Map<string, string> {
  const harnessRoot = join(projectRoot, ".harness");
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) files.set(relative, readFileSync(absolute, "utf8"));
    }
  };
  walk(harnessRoot, "");
  return files;
}

describe("createNewProject", () => {
  it("creates a managed project with a committed deterministic baseline", async () => {
    const parent = makeTempDir("harness-new-");
    const deps = makeDeps();
    const outcome = await createNewProject(
      { parentDirectory: parent, name: "demo-app", intent: "build a demo" },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = outcome.value;
    const projectRoot = join(parent, "demo-app");
    expect(value.projectRoot).toBe(projectRoot);
    expect(value.repositoryId).toBe("repo_demo-app");
    expect(value.projectId).toBe("project_demo-app");
    expect(value.stack).toBe("generic");
    expect(value.iterationId).toBe("iteration_t0001");
    expect(value.branch).toBe("harness/iteration_t0001-bootstrap");

    const manifest = readManagedManifest(projectRoot);
    expect(manifest.name).toBe("demo-app");
    expect(manifest.repository_id).toBe("repo_demo-app");
    expect(manifest.created_at).toBe(FIXED_NOW);

    // Git shape: main holds the control-plane commit; the bootstrap branch
    // adds the recorded baseline on top.
    expect(git(projectRoot, "branch", "--show-current").trim()).toBe(value.branch);
    expect(git(projectRoot, "rev-list", "--count", "main").trim()).toBe("1");
    expect(git(projectRoot, "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(headOf(projectRoot)).toBe(value.headCommit);
    expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");

    // Ledger replay: one operation, one edge, two events, both artifacts.
    const ledger = new LedgerRepository({
      projectRoot,
      readBaseline: () => value.baselineCommit,
    });
    const replay = ledger.replay();
    expect(replay.operations).toHaveLength(1);
    expect(replay.operations[0]?.manifest.ledger_operation_id).toBe(value.ledgerOperationId);
    expect(replay.operations[0]?.manifest.workflow_operation_id).toBe(value.workflowOperationId);
    expect(replay.operations[0]?.manifest.baseline_commit).toBe(value.baselineCommit);
    expect(replay.edges).toHaveLength(1);
    expect(replay.edges[0]?.type).toBe("DERIVES_FROM");
    expect(replay.events.map((event) => event.event_type)).toEqual([
      "OperationStarted",
      "OperationCompleted",
    ]);
    expect(existsSync(join(projectRoot, ".harness", "artifacts", "repositories"))).toBe(true);
    expect(readdirSync(join(projectRoot, ".harness", "artifacts", "iterations"))).toEqual([
      `${value.iterationId}.json`,
    ]);
  });

  it("produces byte-identical .harness trees for identical inputs", async () => {
    // Pin git timestamps so commit hashes — and therefore the recorded
    // baseline binding — are reproducible for identical inputs.
    const savedAuthorDate = process.env.GIT_AUTHOR_DATE;
    const savedCommitterDate = process.env.GIT_COMMITTER_DATE;
    process.env.GIT_AUTHOR_DATE = "2026-08-12T00:00:00Z";
    process.env.GIT_COMMITTER_DATE = "2026-08-12T00:00:00Z";
    try {
      const parentA = makeTempDir("harness-new-a-");
      const parentB = makeTempDir("harness-new-b-");
      const first = await createNewProject(
        { parentDirectory: parentA, name: "demo-app", intent: "build a demo" },
        makeDeps(),
      );
      const second = await createNewProject(
        { parentDirectory: parentB, name: "demo-app", intent: "build a demo" },
        makeDeps(),
      );
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.value.repositoryNodeId).toBe(second.value.repositoryNodeId);
      expect(first.value.baselineCommit).toBe(second.value.baselineCommit);
      const filesA = harnessFiles(first.value.projectRoot);
      const filesB = harnessFiles(second.value.projectRoot);
      expect(Object.fromEntries(filesA)).toEqual(Object.fromEntries(filesB));
    } finally {
      if (savedAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
      else process.env.GIT_AUTHOR_DATE = savedAuthorDate;
      if (savedCommitterDate === undefined) delete process.env.GIT_COMMITTER_DATE;
      else process.env.GIT_COMMITTER_DATE = savedCommitterDate;
    }
  });

  it("refuses an existing target path", async () => {
    const parent = makeTempDir("harness-new-exists-");
    const first = await createNewProject(
      { parentDirectory: parent, name: "demo-app", intent: "x" },
      makeDeps(),
    );
    expect(first.ok).toBe(true);
    const second = await createNewProject(
      { parentDirectory: parent, name: "demo-app", intent: "x" },
      makeDeps(),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe("target_exists");
  });

  it("rejects invalid names and missing parents", async () => {
    const parent = makeTempDir("harness-new-invalid-");
    const invalid = await createNewProject(
      { parentDirectory: parent, name: "Demo_App", intent: "x" },
      makeDeps(),
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.kind).toBe("invalid_name");

    const missing = await createNewProject(
      { parentDirectory: join(parent, "nope"), name: "demo-app", intent: "x" },
      makeDeps(),
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.kind).toBe("parent_not_found");
  });

  it("surfaces VCS failures as typed errors", async () => {
    const parent = makeTempDir("harness-new-vcs-");
    const failing: VcsAdapter = {
      name: "failing",
      initRepository: (): Promise<VcsResult<RepositoryInfo>> =>
        Promise.resolve({
          ok: false,
          error: {
            kind: "executable_unavailable",
            operation: "initRepository",
            message: "git executable could not be spawned",
          },
        }),
      detectRepository: () => Promise.reject(new Error("unused")),
      status: () => Promise.reject(new Error("unused")),
      baselineCommit: () => Promise.reject(new Error("unused")),
      createBranch: () => Promise.reject(new Error("unused")),
      commit: () => Promise.reject(new Error("unused")),
      diffSummary: () => Promise.reject(new Error("unused")),
      detectDrift: () => Promise.reject(new Error("unused")),
      addWorktree: () => Promise.reject(new Error("unused")),
      removeWorktree: () => Promise.reject(new Error("unused")),
    };
    const outcome = await createNewProject(
      { parentDirectory: parent, name: "demo-app", intent: "x" },
      { vcs: failing },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("vcs_failure");
  });

  it("is reachable through the runtime service facade", async () => {
    const parent = makeTempDir("harness-new-service-");
    const service = createRuntimeService(makeDeps());
    const outcome = await service.newProject({
      parentDirectory: parent,
      name: "demo-app",
      intent: "x",
    });
    expect(outcome.ok).toBe(true);
  });
});
