import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { contentDigest, type TaskTddContract } from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import type { Protocol13TaskSpecification } from "../../src/planning/task.js";
import { issueGrant, type CapabilityGrant } from "../../src/policy/capability-grant.js";
import { mergePolicyLayers } from "../../src/policy/evaluator.js";
import {
  createInMemoryTddEvidenceStore,
  createStrictTddExecutionRunner,
  type StrictTddTaskOutcome,
} from "../../src/tdd/execution-runner.js";
import {
  createGitWorktreeWorkspacePort,
  type GitWorktreeWorkspacePort,
} from "../../src/tdd/git-workspace.js";
import type { WorkspaceHandle } from "../../src/tdd/workspace.js";
import { createTaskWorkspaceManager } from "../../src/scheduling/workspace-manager.js";
import { cleanupDirectories, git, headOf, makeRepo, makeTempDir } from "../bootstrap/helpers.js";
import { field, layer } from "../policy/fixtures.js";

/**
 * Plan Task 7 step 1/3/5 (M4 design 4.3/12/13.1) against a real temporary
 * Git repository: same-wave task workspaces are isolated detached worktrees
 * that never move the host HEAD; the canonical patch artifact covers
 * deletions, binary content, mode changes and untracked files; .git,
 * .harness, absolute, traversal and symlink escapes are rejected; a Strict
 * TDD candidate is sourced exclusively from the accepted
 * implementation_revision with no outer task_execution worktree.
 */
const digest = (letter: string): string => letter.repeat(64);
const ASSERTION = "criterion-assertion_01K1AS1";

function task(id: string, writePaths: readonly string[]): Protocol13TaskSpecification {
  return {
    id,
    objective: `objective of ${id}`,
    impact_paths: [],
    expected_outputs: [`output_${id}`],
    capabilities: [],
    tools: [],
    dependencies: [],
    risk: "low",
    budget: { steps: 20, tokens: 2_000, duration_ms: 60_000 },
    write_paths: writePaths,
    exclusive_resources: [],
    acceptance: [{ description: "done", verification: "target gate" }],
    assertions: [
      {
        assertion_id: ASSERTION,
        test_ids: ["test_items"],
        required_gate_ids: ["gate_items"],
        evidence_requirements: ["gate_evidence"],
      },
    ],
    required_gates: ["gate_items"],
  };
}

function effectivePolicy() {
  return mergePolicyLayers([
    layer("project", [
      field("paths.write.allow", "allow_intersection", [
        "src",
        "tests",
        "scripts",
        "assets",
        "docs",
        "vitest.config.ts",
      ]),
      field("paths.read.allow", "allow_intersection", [
        "src",
        "tests",
        "scripts",
        "assets",
        "docs",
        "vitest.config.ts",
      ]),
    ]),
  ]).effective;
}

function grantFor(
  taskId: string,
  writePaths: readonly string[],
  phase = "execution",
): CapabilityGrant {
  return issueGrant(
    {
      grant_id: `grant_${taskId}_${phase}`,
      task_id: taskId,
      capabilities: [],
      read_paths: ["src", "tests", "vitest.config.ts"],
      write_paths: writePaths,
      tools: [],
      phase,
      budget: { steps: 20, tokens: 2_000 },
    },
    effectivePolicy(),
  );
}

function makeManager(repositoryRoot: string) {
  const managedRoot = makeTempDir("harness-m4-managed-");
  const port = createGitWorktreeWorkspacePort({
    repositoryRoot,
    workspaceRoot: join(managedRoot, "worktrees"),
  });
  const creates: { readonly purpose: string }[] = [];
  const recording: GitWorktreeWorkspacePort = {
    ...port,
    async create(input) {
      creates.push({ purpose: input.purpose });
      return port.create(input);
    },
    rootOf: (handle) => port.rootOf(handle),
  };
  const manager = createTaskWorkspaceManager({
    repositoryRoot,
    managedRoot,
    workspace: recording,
  });
  return { manager, managedRoot, creates };
}

describe("task execution workspaces (real git)", { timeout: 60000 }, () => {
  it("isolates two same-base workspaces and never moves the host HEAD", async () => {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;", "src/b.ts": "export const b = 2;" });
    const base = headOf(repo);
    const { manager } = makeManager(repo);
    const leftTask = task("task_left", ["src"]);
    const rightTask = task("task_right", ["src"]);
    try {
      const left = await manager.prepareTaskWorkspace({
        task: leftTask,
        baseline_commit: base,
        slot_id: "slot_1",
      });
      const right = await manager.prepareTaskWorkspace({
        task: rightTask,
        baseline_commit: base,
        slot_id: "slot_2",
      });
      expect(left.handle.baseline_commit).toBe(base);
      expect(right.handle.baseline_commit).toBe(base);
      expect(left.root).not.toBe(right.root);
      expect(headOf(repo)).toBe(base);

      // Disjoint agent writes inside the isolated worktrees.
      await writeFile(join(left.root, "src/a.ts"), "export const a = 42;", "utf8");
      await writeFile(join(right.root, "src/b.ts"), "export const b = 43;", "utf8");

      const leftCandidate = await manager.collectTaskCandidate({
        task: leftTask,
        workspace: left,
        task_grant: grantFor(leftTask.id, ["src"]),
      });
      const rightCandidate = await manager.collectTaskCandidate({
        task: rightTask,
        workspace: right,
        task_grant: grantFor(rightTask.id, ["src"]),
      });
      expect(leftCandidate.task_id).toBe("task_left");
      expect(leftCandidate.baseline_commit).toBe(base);
      expect(leftCandidate.changed_paths).toEqual(["src/a.ts"]);
      expect(rightCandidate.changed_paths).toEqual(["src/b.ts"]);
      expect(leftCandidate.source_revision).toBeUndefined();
      expect(leftCandidate.patch_digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(leftCandidate.source_tree_digest).toMatch(/^[0-9a-f]{64}$/u);
      const leftPatch = await readFile(leftCandidate.patch_locator, "utf8");
      expect(leftPatch).toContain("src/a.ts");
      expect(leftPatch).not.toContain("src/b.ts");
      // Disjoint patches carry disjoint digests and trees.
      expect(leftCandidate.patch_digest).not.toBe(rightCandidate.patch_digest);
      expect(leftCandidate.source_tree_digest).not.toBe(rightCandidate.source_tree_digest);

      // The host repository is never touched by task workspaces.
      expect(headOf(repo)).toBe(base);
      expect(git(repo, "status", "--porcelain")).toBe("");

      // Normal release removes the workspace after the patch is persisted.
      await manager.discardTaskWorkspace(left.workspace_id);
      await manager.discardTaskWorkspace(right.workspace_id);
      expect(existsSync(left.root)).toBe(false);
      expect(existsSync(right.root)).toBe(false);
      expect(existsSync(leftCandidate.patch_locator)).toBe(true);
    } finally {
      cleanupDirectories();
    }
  });

  it("produces a canonical patch for deletion, binary, mode and untracked changes", async () => {
    const repo = makeRepo({
      "src/delete-me.ts": "export const gone = true;",
      "src/run.sh": "#!/bin/sh\necho hi\n",
    });
    mkdirSync(join(repo, "assets"), { recursive: true });
    writeFileSync(join(repo, "assets/logo.bin"), Buffer.from([0, 1, 2, 250, 251, 252]));
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "add binary asset");
    const base = headOf(repo);
    const { manager } = makeManager(repo);
    const spec = task("task_01", ["src", "assets"]);
    try {
      const workspace = await manager.prepareTaskWorkspace({
        task: spec,
        baseline_commit: base,
        slot_id: "slot_1",
      });
      await rm(join(workspace.root, "src/delete-me.ts"));
      await writeFile(join(workspace.root, "assets/logo.bin"), Buffer.from([9, 8, 7, 6]));
      if (process.platform !== "win32") {
        await chmod(join(workspace.root, "src/run.sh"), 0o755);
      }
      // An untracked file is part of the candidate.
      await writeFile(join(workspace.root, "src/new.ts"), "export const fresh = 1;", "utf8");

      const candidate = await manager.collectTaskCandidate({
        task: spec,
        workspace,
        task_grant: grantFor(spec.id, ["src", "assets"]),
      });
      // Windows git runs with core.filemode=false, so the run.sh mode change
      // is invisible there and the file drops out of the changed set.
      expect(candidate.changed_paths).toEqual(
        process.platform === "win32"
          ? ["assets/logo.bin", "src/delete-me.ts", "src/new.ts"]
          : ["assets/logo.bin", "src/delete-me.ts", "src/new.ts", "src/run.sh"],
      );
      const patch = await readFile(candidate.patch_locator, "utf8");
      expect(patch).toContain("GIT binary patch");
      expect(patch).toContain("deleted file mode");
      if (process.platform !== "win32") {
        expect(patch).toContain("old mode 100644");
        expect(patch).toContain("new mode 100755");
      }
      expect(patch).toContain("new file mode");
      // The binary payload round-trips through the managed patch artifact.
      const applyRoot = makeTempDir("harness-m4-apply-");
      git(repo, "worktree", "add", "--detach", applyRoot, base);
      git(applyRoot, "apply", "--binary", candidate.patch_locator);
      expect(await readFile(join(applyRoot, "assets/logo.bin"))).toEqual(Buffer.from([9, 8, 7, 6]));
      expect(existsSync(join(applyRoot, "src/delete-me.ts"))).toBe(false);
      await manager.discardTaskWorkspace(workspace.workspace_id);
    } finally {
      cleanupDirectories();
    }
  });

  it("rejects undeclared writes and keeps the diagnostic workspace", async () => {
    const repo = makeRepo({ "src/a.ts": "a", "docs/README.md": "d" });
    const base = headOf(repo);
    const { manager } = makeManager(repo);
    const spec = task("task_01", ["src"]);
    try {
      const workspace = await manager.prepareTaskWorkspace({
        task: spec,
        baseline_commit: base,
        slot_id: "slot_1",
      });
      await writeFile(join(workspace.root, "docs/README.md"), "smuggled", "utf8");
      await expect(
        manager.collectTaskCandidate({
          task: spec,
          workspace,
          task_grant: grantFor(spec.id, ["src"]),
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "write_set_violation" });
      // Policy-blocked workspaces are retained for diagnosis, not destroyed.
      await manager.discardTaskWorkspace(workspace.workspace_id);
      expect(existsSync(workspace.root)).toBe(true);
    } finally {
      cleanupDirectories();
    }
  });

  it("rejects .harness writes, embedded git repositories and symlink escapes", async () => {
    const repo = makeRepo({ "src/a.ts": "a" });
    const base = headOf(repo);
    const spec = task("task_01", ["src", ".harness"]);

    // .harness authoritative root.
    {
      const { manager } = makeManager(repo);
      const workspace = await manager.prepareTaskWorkspace({
        task: spec,
        baseline_commit: base,
        slot_id: "slot_1",
      });
      await mkdir(join(workspace.root, ".harness"), { recursive: true });
      await writeFile(join(workspace.root, ".harness/ledger.json"), "{}", "utf8");
      await expect(
        manager.collectTaskCandidate({
          task: spec,
          workspace,
          task_grant: grantFor(spec.id, ["src"]),
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "path_escape" });
    }

    // Embedded git repository (would become an unmanaged gitlink).
    {
      const { manager } = makeManager(repo);
      const workspace = await manager.prepareTaskWorkspace({
        task: spec,
        baseline_commit: base,
        slot_id: "slot_1",
      });
      const nested = join(workspace.root, "src/nested");
      await mkdir(nested, { recursive: true });
      git(nested, "init", "-b", "main");
      git(nested, "config", "user.name", "Harness Test");
      git(nested, "config", "user.email", "harness-test@example.invalid");
      await writeFile(join(nested, "smuggled.ts"), "x", "utf8");
      git(nested, "add", "-A");
      git(nested, "commit", "-m", "nested");
      await expect(
        manager.collectTaskCandidate({
          task: spec,
          workspace,
          task_grant: grantFor(spec.id, ["src"]),
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "path_escape" });
    }

    // Symlink escaping the worktree.
    {
      const { manager } = makeManager(repo);
      const workspace = await manager.prepareTaskWorkspace({
        task: spec,
        baseline_commit: base,
        slot_id: "slot_1",
      });
      const outside = makeTempDir("harness-m4-target-");
      await writeFile(join(outside, "secret.txt"), "secret", "utf8");
      await symlink(join(outside, "secret.txt"), join(workspace.root, "src/evil-link"));
      await expect(
        manager.collectTaskCandidate({
          task: spec,
          workspace,
          task_grant: grantFor(spec.id, ["src"]),
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "path_escape" });
    }

    // Symlink resolving into the .git store.
    {
      const { manager } = makeManager(repo);
      const workspace = await manager.prepareTaskWorkspace({
        task: spec,
        baseline_commit: base,
        slot_id: "slot_1",
      });
      await symlink("../.git", join(workspace.root, "src/git-link"));
      await expect(
        manager.collectTaskCandidate({
          task: spec,
          workspace,
          task_grant: grantFor(spec.id, ["src"]),
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "path_escape" });
    }
    cleanupDirectories();
  });

  it("blocks collection when the effective write scope is empty", async () => {
    const repo = makeRepo({ "src/a.ts": "a" });
    const base = headOf(repo);
    const { manager } = makeManager(repo);
    const spec = task("task_01", ["src"]);
    try {
      const workspace = await manager.prepareTaskWorkspace({
        task: spec,
        baseline_commit: base,
        slot_id: "slot_1",
      });
      await writeFile(join(workspace.root, "src/a.ts"), "changed", "utf8");
      // The grant narrows the task claim to nothing: blocked before any diff.
      await expect(
        manager.collectTaskCandidate({
          task: spec,
          workspace,
          task_grant: grantFor(spec.id, ["docs"]),
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "empty_write_scope" });
    } finally {
      cleanupDirectories();
    }
  });
});

/** Run one real Strict TDD cycle against real worktrees, returning the outcome and observed purposes. */
async function runStrictTdd(repo: string, baseline: string, spec: Protocol13TaskSpecification) {
  const purposes: string[] = [];
  const basePort = createGitWorktreeWorkspacePort({ repositoryRoot: repo });
  const port: GitWorktreeWorkspacePort = {
    ...basePort,
    async create(input) {
      purposes.push(input.purpose);
      return basePort.create(input);
    },
    rootOf: (handle: WorkspaceHandle) => basePort.rootOf(handle),
  };
  const evidence = createInMemoryTddEvidenceStore();
  const runner = createStrictTddExecutionRunner({
    workspace: port,
    evidence,
    effectivePolicy: effectivePolicy(),
    readBaseline: () => baseline,
    gate: {
      run(input) {
        const failed = input.phase === "red";
        return Promise.resolve({
          result: {
            outcome: "structured" as const,
            runs: [
              {
                selector_id: "tests/items.test.ts",
                status: failed ? ("failed" as const) : ("passed" as const),
                assertion_id: ASSERTION,
                ...(failed ? { failure_kind: "assertion_failure" } : {}),
              },
            ],
          },
          target_gate_binding_digest: digest("a"),
          framework_profile_digest: digest("8"),
          executor_environment_digest: digest("b"),
          output_artifact: {
            locator: `artifacts/tdd/${input.phase}.json`,
            digest: contentDigest({ phase: input.phase, failed }),
          },
        });
      },
    },
    executor: {
      authorTests() {
        return Promise.resolve({
          files: [{ path: "tests/items.test.ts", content: "expect(lookup()).toBeDefined();" }],
        });
      },
      async implement(input) {
        // The executor seals the workspace state as a commit object without
        // moving the worktree HEAD (plumbing + scratch index), mirroring how
        // a Strict TDD adapter would produce implementation_revision. The
        // manager later re-derives everything from Git — the commit message
        // and other agent metadata are never trusted.
        const root = port.rootOf(input.workspace);
        if (root === undefined) throw new Error("no worktree root for implementation");
        await writeFile(join(root, "src/items.ts"), "export const lookup = () => 1;", "utf8");
        const indexFile = join(makeTempDir("harness-m4-idx-"), "index");
        const env = { ...process.env, GIT_INDEX_FILE: indexFile };
        const run = (args: readonly string[]): string =>
          execFileSync("git", [...args], { cwd: root, env, encoding: "utf8" });
        run(["read-tree", "HEAD"]);
        run(["add", "-A"]);
        const tree = run(["write-tree"]).trim();
        const revision = execFileSync(
          "git",
          ["commit-tree", tree, "-p", "HEAD", "-m", "agent claims this is fine"],
          { cwd: root, encoding: "utf8" },
        ).trim();
        return {
          files: [{ path: "src/items.ts", content: "export const lookup = () => 1;" }],
          implementation_revision: revision,
        };
      },
    },
  });
  const outcome = await runner.runTask({
    task: spec,
    contract: tddContract(spec),
    capability_plan_digest: digest("5"),
  });
  return { outcome, purposes };
}

function tddContract(spec: Protocol13TaskSpecification): TaskTddContract {
  return {
    contract_id: "tdd-contract_01",
    task_id: spec.id,
    contract_mode: "required",
    accepted_prd_digest: digest("1"),
    requirement_baseline_digest: digest("2"),
    impact_set_digest: digest("3"),
    design_set_digest: digest("4"),
    capability_plan_digest: digest("5"),
    test_strategy_asset_id: "design-artifact_tests",
    test_strategy_digest: digest("6"),
    plan_digest: digest("7"),
    assertion_clusters: [
      {
        cluster_id: "assertion-cluster_01",
        logical_cycle_id: "tdd-cycle_01",
        requirement_ids: ["requirement_01"],
        acceptance_criterion_ids: ["criterion_01"],
        assertion_ids: [ASSERTION],
        test_node_ids: ["test_items"],
        target_gate_id: "gate_items",
        target_test_selectors: ["tests/items.test.ts"],
        baseline_guard_gate_ids: ["gate_items"],
        failure_oracle: {
          selector_ids: ["tests/items.test.ts"],
          allowed_failure_kinds: ["assertion_failure"],
          assertion_ids: [ASSERTION],
        },
        path_policy: {
          test: ["tests/**"],
          test_config: ["vitest.config.ts"],
          production: ["src/**"],
          immutable: [".harness/**"],
        },
        framework_profile_digest: digest("8"),
        refactor_policy: "not_planned",
      },
    ],
    phase_budgets: {
      test_authoring: { max_runs: 2, max_duration_ms: 2_000, max_steps: 10, max_tokens: 1_000 },
      implementation: { max_runs: 2, max_duration_ms: 2_000, max_steps: 10, max_tokens: 1_000 },
    },
    contract_digest: digest("9"),
  } as TaskTddContract;
}

/** Commit a handcrafted revision on top of `base` carrying one symlink entry. */
function commitWithSymlink(repo: string, base: string, path: string, target: string): string {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    input: target,
    encoding: "utf8",
  }).trim();
  const listing = git(repo, "ls-tree", base);
  const entries = listing
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [meta, entryPath] = line.split("\t");
      const [mode, type, oid] = meta!.split(" ");
      return `${mode} ${type} ${oid}\t${entryPath}`;
    });
  entries.push(`120000 blob ${blob}\t${path}`);
  entries.sort((left, right) => {
    const leftPath = left.split("\t")[1] as string;
    const rightPath = right.split("\t")[1] as string;
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  const tree = execFileSync("git", ["mktree"], {
    cwd: repo,
    input: `${entries.join("\n")}\n`,
    encoding: "utf8",
  }).trim();
  return execFileSync("git", ["commit-tree", tree, "-p", base, "-m", "crafted"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

function completedOutcome(outcome: StrictTddTaskOutcome) {
  if (outcome.status !== "completed") {
    throw new Error(
      `expected a completed TDD outcome, got: ${outcome.reason} ${JSON.stringify(outcome.issues)}`,
    );
  }
  return outcome;
}

describe("strict TDD candidate composition (real git)", { timeout: 60000 }, () => {
  async function completedFixture() {
    const repo = makeRepo({
      "src/items.ts": "export const lookup = () => undefined;",
      "tests/items.test.ts": "",
      "vitest.config.ts": "export default {};",
    });
    const baseline = headOf(repo);
    const spec = task("task_01", ["src", "tests", "vitest.config.ts"]);
    const { outcome, purposes } = await runStrictTdd(repo, baseline, spec);
    return { repo, baseline, spec, outcome: completedOutcome(outcome), purposes };
  }

  it("sources the candidate exclusively from the accepted implementation_revision", async () => {
    const { repo, baseline, spec, outcome, purposes } = await completedFixture();
    const { manager, creates } = makeManager(repo);
    try {
      // The runner used phase workspaces only; the manager creates no outer
      // task_execution worktree for a Strict TDD task.
      expect(purposes).not.toContain("task_execution");
      const candidate = await manager.collectStrictTddCandidate({
        task: spec,
        outcome,
        task_grant: grantFor(spec.id, ["src", "tests", "vitest.config.ts"]),
        phase_grant: grantFor(spec.id, ["src/**", "tests/**"], "implementation"),
        path_policy: {
          test: ["tests/**"],
          test_config: ["vitest.config.ts"],
          production: ["src/**"],
          immutable: [".harness/**"],
        },
      });
      expect(creates.map((entry) => entry.purpose)).not.toContain("task_execution");
      expect(candidate.source_revision).toBe(outcome.implementation_revision);
      expect(candidate.task_id).toBe(spec.id);
      expect(candidate.baseline_commit).toBe(baseline);
      expect(candidate.changed_paths).toEqual(["src/items.ts", "tests/items.test.ts"]);
      expect(candidate.patch_digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(candidate.source_tree_digest).toMatch(/^[0-9a-f]{64}$/u);
      const patch = await readFile(candidate.patch_locator, "utf8");
      expect(patch).toContain("src/items.ts");
      expect(patch).toContain("tests/items.test.ts");
      // Agent commit metadata is never an input: the artifact is re-derived
      // from the revision's tree, so the message above cannot leak in.
      expect(patch).not.toContain("agent claims this is fine");
    } finally {
      cleanupDirectories();
    }
  });

  it("rejects a revision that does not exist in git", async () => {
    const { repo, spec, outcome } = await completedFixture();
    const { manager } = makeManager(repo);
    const missing = "f".repeat(40);
    try {
      await expect(
        manager.collectStrictTddCandidate({
          task: spec,
          outcome: {
            ...outcome,
            implementation_revision: missing,
            cycle: { ...outcome.cycle, implementation_revision: missing },
          },
          task_grant: grantFor(spec.id, ["src", "tests"]),
          phase_grant: grantFor(spec.id, ["src/**", "tests/**"], "implementation"),
          path_policy: tddContract(spec).assertion_clusters[0]!.path_policy,
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "revision_mismatch" });
    } finally {
      cleanupDirectories();
    }
  });

  it("rejects an outcome revision that differs from the TDD cycle", async () => {
    const { repo, spec, outcome, baseline } = await completedFixture();
    const { manager } = makeManager(repo);
    try {
      await expect(
        manager.collectStrictTddCandidate({
          task: spec,
          // The outcome claims a different (real) commit than the cycle accepted.
          outcome: { ...outcome, implementation_revision: baseline },
          task_grant: grantFor(spec.id, ["src", "tests"]),
          phase_grant: grantFor(spec.id, ["src/**", "tests/**"], "implementation"),
          path_policy: tddContract(spec).assertion_clusters[0]!.path_policy,
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "revision_mismatch" });
    } finally {
      cleanupDirectories();
    }
  });

  it("rejects results without accepted Red/Green evidence", async () => {
    const { repo, spec, outcome } = await completedFixture();
    const { manager } = makeManager(repo);
    const pathPolicy = tddContract(spec).assertion_clusters[0]!.path_policy;
    try {
      await expect(
        manager.collectStrictTddCandidate({
          task: spec,
          outcome: { ...outcome, evidence: [] },
          task_grant: grantFor(spec.id, ["src", "tests"]),
          phase_grant: grantFor(spec.id, ["src/**", "tests/**"], "implementation"),
          path_policy: pathPolicy,
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "missing_evidence" });
      const redDigest = outcome.cycle.red_evidence_digest!;
      await expect(
        manager.collectStrictTddCandidate({
          task: spec,
          outcome: {
            ...outcome,
            evidence: outcome.evidence.filter((entry) => contentDigest(entry) !== redDigest),
          },
          task_grant: grantFor(spec.id, ["src", "tests"]),
          phase_grant: grantFor(spec.id, ["src/**", "tests/**"], "implementation"),
          path_policy: pathPolicy,
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "missing_evidence" });
    } finally {
      cleanupDirectories();
    }
  });

  it("rejects final paths outside the four-way write-scope intersection", async () => {
    const { repo, spec, outcome } = await completedFixture();
    const { manager } = makeManager(repo);
    const pathPolicy = tddContract(spec).assertion_clusters[0]!.path_policy;
    try {
      // The task claim covers production only: the accepted test patch falls
      // outside the effective intersection and blocks the candidate.
      await expect(
        manager.collectStrictTddCandidate({
          task: spec,
          outcome,
          task_grant: grantFor(spec.id, ["src"]),
          phase_grant: grantFor(spec.id, ["src"], "implementation"),
          path_policy: pathPolicy,
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "write_set_violation" });
    } finally {
      cleanupDirectories();
    }
  });

  it("blocks on an empty intersection before resolving the revision", async () => {
    const { repo, spec, outcome } = await completedFixture();
    const { manager } = makeManager(repo);
    try {
      await expect(
        manager.collectStrictTddCandidate({
          task: spec,
          // Even a bogus revision must not be touched once the intersection is empty.
          outcome: {
            ...outcome,
            implementation_revision: "0".repeat(40),
            cycle: { ...outcome.cycle, implementation_revision: "0".repeat(40) },
          },
          task_grant: grantFor(spec.id, ["docs"]),
          phase_grant: grantFor(spec.id, ["src/**", "tests/**"], "implementation"),
          path_policy: tddContract(spec).assertion_clusters[0]!.path_policy,
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "empty_write_scope" });
    } finally {
      cleanupDirectories();
    }
  });

  it("rejects a revision whose tree smuggles a symlink escape", async () => {
    const { repo, baseline, spec, outcome } = await completedFixture();
    const { manager } = makeManager(repo);
    const evil = commitWithSymlink(repo, baseline, "evil-link", "/etc/passwd");
    try {
      await expect(
        manager.collectStrictTddCandidate({
          task: spec,
          outcome: {
            ...outcome,
            implementation_revision: evil,
            cycle: { ...outcome.cycle, implementation_revision: evil },
          },
          task_grant: grantFor(spec.id, ["src", "tests"]),
          phase_grant: grantFor(spec.id, ["src/**", "tests/**"], "implementation"),
          path_policy: tddContract(spec).assertion_clusters[0]!.path_policy,
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "path_escape" });
    } finally {
      cleanupDirectories();
    }
  });

  it("rejects a revision that is not built on the cycle baseline", async () => {
    const { repo, spec, outcome } = await completedFixture();
    const { manager } = makeManager(repo);
    // An orphan root commit never descends from the cycle baseline.
    const tree = git(repo, "rev-parse", `${outcome.implementation_revision}^{tree}`).trim();
    const orphan = execFileSync("git", ["commit-tree", tree, "-m", "orphan"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    try {
      await expect(
        manager.collectStrictTddCandidate({
          task: spec,
          outcome: {
            ...outcome,
            implementation_revision: orphan,
            cycle: { ...outcome.cycle, implementation_revision: orphan },
          },
          task_grant: grantFor(spec.id, ["src", "tests"]),
          phase_grant: grantFor(spec.id, ["src/**", "tests/**"], "implementation"),
          path_policy: tddContract(spec).assertion_clusters[0]!.path_policy,
        }),
      ).rejects.toMatchObject({ name: "TaskWorkspaceError", kind: "revision_mismatch" });
    } finally {
      cleanupDirectories();
    }
  });
});
