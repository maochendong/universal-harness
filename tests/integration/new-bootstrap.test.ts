import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LedgerRepository, findProjectRoot } from "../../packages/core/src/index.js";
import { createRuntimeService } from "../../packages/runtime/src/index.js";
import {
  cleanupDirectories,
  git,
  makeDeps,
  makeTempDir,
} from "../../packages/runtime/test/bootstrap/helpers.js";

/**
 * New-project bootstrap integration (plan Task 9): the runtime service drives
 * a real Git repository end to end, and identical inputs reproduce the
 * baseline byte-for-byte.
 */
afterEach(cleanupDirectories);

async function withPinnedGitDates(run: () => Promise<void>): Promise<void> {
  const savedAuthorDate = process.env.GIT_AUTHOR_DATE;
  const savedCommitterDate = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_AUTHOR_DATE = "2026-08-12T00:00:00Z";
  process.env.GIT_COMMITTER_DATE = "2026-08-12T00:00:00Z";
  try {
    await run();
  } finally {
    if (savedAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
    else process.env.GIT_AUTHOR_DATE = savedAuthorDate;
    if (savedCommitterDate === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = savedCommitterDate;
  }
}

function readTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) result[relative] = readFileSync(absolute, "utf8");
    }
  };
  walk(join(root, ".harness"), "");
  return result;
}

describe("new project bootstrap integration", () => {
  it("bootstraps a real repository and replays its baseline from the ledger", async () => {
    const parent = makeTempDir("harness-it-new-");
    const service = createRuntimeService(makeDeps());
    const outcome = await service.newProject({
      parentDirectory: parent,
      name: "demo-app",
      intent: "build a demo",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = outcome.value;
    const projectRoot = value.projectRoot;

    // The project is discoverable from any nested directory.
    expect(findProjectRoot(join(projectRoot, "src", "deep"))).toBe(projectRoot);

    // Git lifecycle: control plane on main, baseline on the bootstrap branch.
    expect(git(projectRoot, "rev-parse", "main").trim()).toBe(value.baselineCommit);
    expect(git(projectRoot, "branch", "--show-current").trim()).toBe(value.branch);
    const log = git(projectRoot, "log", "--format=%s", "HEAD");
    expect(log).toBe("harness: record bootstrap baseline\nharness: initialize control plane\n");
    expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");

    // Only managed paths are committed by the harness.
    const committedPaths = git(projectRoot, "ls-tree", "-r", "--name-only", "HEAD")
      .trim()
      .split("\n");
    expect(committedPaths.every((path) => path.startsWith(".harness/"))).toBe(true);
    expect(committedPaths).toContain(".harness/manifest.yaml");
    expect(committedPaths).toContain(".harness/harness.lock");
    expect(
      committedPaths.some(
        (path) => path.startsWith(".harness/ledger/operations/") && path.endsWith(".json"),
      ),
    ).toBe(true);
    // Local-only state never enters Git.
    expect(committedPaths.some((path) => path.includes("/staging/"))).toBe(false);

    // Replay yields exactly the committed baseline.
    const replay = new LedgerRepository({
      projectRoot,
      readBaseline: () => value.baselineCommit,
    }).replay();
    expect(replay.operations).toHaveLength(1);
    expect(replay.edges).toHaveLength(1);
    expect(replay.events).toHaveLength(2);
    const repositoryArtifact = readdirSync(
      join(projectRoot, ".harness", "artifacts", "repositories"),
    );
    expect(repositoryArtifact).toEqual([`${value.repositoryNodeId}.json`]);
    expect(existsSync(join(projectRoot, ".harness", "cache"))).toBe(true);
  });

  it("reproduces the same baseline for identical inputs", async () => {
    await withPinnedGitDates(async () => {
      const serviceA = createRuntimeService(makeDeps());
      const serviceB = createRuntimeService(makeDeps());
      const first = await serviceA.newProject({
        parentDirectory: makeTempDir("harness-it-new-a-"),
        name: "demo-app",
        intent: "build a demo",
      });
      const second = await serviceB.newProject({
        parentDirectory: makeTempDir("harness-it-new-b-"),
        name: "demo-app",
        intent: "build a demo",
      });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.value.baselineCommit).toBe(second.value.baselineCommit);
      expect(first.value.headCommit).toBe(second.value.headCommit);
      expect(first.value.repositoryNodeId).toBe(second.value.repositoryNodeId);
      expect(readTree(first.value.projectRoot)).toEqual(readTree(second.value.projectRoot));
    });
  });
});
