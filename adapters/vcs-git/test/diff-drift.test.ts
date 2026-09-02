import { afterEach, describe, expect, it } from "vitest";

import { adapter, cleanupDirectories, git, headOf, makeRepo, writeRepoFile } from "./helpers.js";

afterEach(cleanupDirectories);

describe("diffSummary", () => {
  it("summarizes added, modified and deleted files between commits", async () => {
    const root = makeRepo();
    const from = headOf(root);
    writeRepoFile(root, "README.md", "one\ntwo\nthree\n");
    writeRepoFile(root, "added.ts", "export {};\n");
    git(root, "add", "README.md", "added.ts");
    git(root, "commit", "-m", "changes");
    const to = headOf(root);

    const result = await adapter.diffSummary(root, from, to);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.from).toBe(from);
    expect(result.value.to).toBe(to);
    expect(result.value.files).toEqual([
      { path: "README.md", status: "modified", insertions: 3, deletions: 1 },
      { path: "added.ts", status: "added", insertions: 1, deletions: 0 },
    ]);
    expect(result.value.insertions).toBe(4);
    expect(result.value.deletions).toBe(1);
  });

  it("detects renames with their previous path", async () => {
    const root = makeRepo();
    const from = headOf(root);
    git(root, "mv", "README.md", "GUIDE.md");
    git(root, "commit", "-m", "rename readme");

    const result = await adapter.diffSummary(root, from, "HEAD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path: "GUIDE.md",
        status: "renamed",
        previousPath: "README.md",
        insertions: 0,
        deletions: 0,
      },
    ]);
  });

  it("reports deletions", async () => {
    const root = makeRepo();
    const from = headOf(root);
    git(root, "rm", "-q", "README.md");
    git(root, "commit", "-m", "delete readme");

    const result = await adapter.diffSummary(root, from, "HEAD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      { path: "README.md", status: "deleted", insertions: 0, deletions: 1 },
    ]);
  });

  it("diffs against the worktree when no target is given", async () => {
    const root = makeRepo();
    const from = headOf(root);
    writeRepoFile(root, "README.md", "worktree change\nextra line\n");

    const result = await adapter.diffSummary(root, from);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.to).toBe("worktree");
    expect(result.value.files).toEqual([
      { path: "README.md", status: "modified", insertions: 2, deletions: 1 },
    ]);
  });

  it("skips nested repositories listed as untracked directory entries", async () => {
    const root = makeRepo();
    const from = headOf(root);
    git(root, "init", "-b", "main", "nested");
    writeRepoFile(root, "loose.ts", "export {};\n");

    const result = await adapter.diffSummary(root, from);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      { path: "loose.ts", status: "added", insertions: 1, deletions: 0 },
    ]);
  });

  it("reports ref_not_found for an unknown base", async () => {
    const root = makeRepo();
    const result = await adapter.diffSummary(root, "deadbeef".repeat(5));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("ref_not_found");
  });
});

describe("detectDrift", () => {
  it("reports no drift at the baseline with a clean worktree", async () => {
    const root = makeRepo();
    const baseline = headOf(root);
    const result = await adapter.detectDrift(root, baseline);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drifted).toBe(false);
    expect(result.value.ahead).toBe(0);
    expect(result.value.behind).toBe(0);
    expect(result.value.head).toBe(baseline);
  });

  it("detects commits added on top of the baseline", async () => {
    const root = makeRepo();
    const baseline = headOf(root);
    writeRepoFile(root, "feature.ts", "export {};\n");
    git(root, "add", "feature.ts");
    git(root, "commit", "-m", "feature work");

    const result = await adapter.detectDrift(root, baseline);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drifted).toBe(true);
    expect(result.value.ahead).toBe(1);
    expect(result.value.behind).toBe(0);
  });

  it("detects a worktree dirtied after the baseline", async () => {
    const root = makeRepo();
    const baseline = headOf(root);
    writeRepoFile(root, "README.md", "tampered\n");

    const result = await adapter.detectDrift(root, baseline);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drifted).toBe(true);
    expect(result.value.worktree.unstaged).toEqual(["README.md"]);
  });

  it("detects divergence between baseline and HEAD", async () => {
    const root = makeRepo();
    const first = headOf(root);
    writeRepoFile(root, "a.txt", "a\n");
    git(root, "add", "a.txt");
    git(root, "commit", "-m", "commit a");
    const baseline = headOf(root);
    git(root, "reset", "--hard", "-q", first);
    writeRepoFile(root, "b.txt", "b\n");
    git(root, "add", "b.txt");
    git(root, "commit", "-m", "commit b");

    const result = await adapter.detectDrift(root, baseline);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drifted).toBe(true);
    expect(result.value.ahead).toBe(1);
    expect(result.value.behind).toBe(1);
  });

  it("reports ref_not_found for an unknown baseline", async () => {
    const root = makeRepo();
    const result = await adapter.detectDrift(root, "deadbeef".repeat(5));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("ref_not_found");
  });
});
