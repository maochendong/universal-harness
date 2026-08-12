import { afterEach, describe, expect, it } from "vitest";

import { adapter, cleanupDirectories, git, headOf, makeRepo, writeRepoFile } from "./helpers.js";

afterEach(cleanupDirectories);

describe("createBranch", () => {
  it("creates and switches to a new branch at HEAD", async () => {
    const root = makeRepo();
    const head = headOf(root);
    const result = await adapter.createBranch(root, "harness/iteration_01-feature");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBe("harness/iteration_01-feature");
    expect(result.value.head).toBe(head);
    expect(git(root, "branch", "--show-current").trim()).toBe("harness/iteration_01-feature");
  });

  it("creates a branch from an explicit start point without switching", async () => {
    const root = makeRepo();
    writeRepoFile(root, "second.txt", "second\n");
    git(root, "add", "second.txt");
    git(root, "commit", "-m", "second commit");
    const first = git(root, "rev-parse", "HEAD~1").trim();
    const result = await adapter.createBranch(root, "harness/from-first", {
      startPoint: first,
      checkout: false,
    });
    expect(result.ok).toBe(true);
    expect(git(root, "rev-parse", "harness/from-first").trim()).toBe(first);
    expect(git(root, "branch", "--show-current").trim()).toBe("main");
  });

  it("rejects invalid branch names", async () => {
    const root = makeRepo();
    const result = await adapter.createBranch(root, "bad..name");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_argument");
  });

  it("treats option-like branch names as data, not flags", async () => {
    const root = makeRepo();
    const result = await adapter.createBranch(root, "-d");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_argument");
    // The repository still exists and main is untouched.
    expect(git(root, "branch", "--show-current").trim()).toBe("main");
  });
});

describe("commit", () => {
  it("commits only the declared paths and preserves other user changes", async () => {
    const root = makeRepo();
    writeRepoFile(root, "artifact.json", '{"artifact":1}\n');
    writeRepoFile(root, "staged-user.txt", "user staged\n");
    git(root, "add", "staged-user.txt");
    writeRepoFile(root, "dirty-user.txt", "user dirty\n");

    const result = await adapter.commit(root, {
      message: "harness: record artifact",
      paths: ["artifact.json"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(headOf(root));

    const committed = git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
      .split("\n")
      .filter(Boolean);
    expect(committed).toEqual(["artifact.json"]);
    // User changes survive: staged stays staged, dirty stays untracked.
    const status = await adapter.status(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.staged).toEqual(["staged-user.txt"]);
    expect(status.value.untracked).toEqual(["dirty-user.txt"]);
  });

  it("commits declared modifications alongside unrelated staged changes", async () => {
    const root = makeRepo();
    writeRepoFile(root, "README.md", "updated by harness\n");
    writeRepoFile(root, "user.txt", "user work\n");
    git(root, "add", "user.txt");

    const result = await adapter.commit(root, {
      message: "harness: update readme",
      paths: ["README.md"],
    });
    expect(result.ok).toBe(true);
    const committed = git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim();
    expect(committed).toBe("README.md");
    const status = await adapter.status(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.staged).toEqual(["user.txt"]);
  });

  it("reports nothing_to_commit when declared paths are unchanged", async () => {
    const root = makeRepo();
    const result = await adapter.commit(root, {
      message: "harness: no-op",
      paths: ["README.md"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("nothing_to_commit");
  });

  it("rejects commits without declared paths or message", async () => {
    const root = makeRepo();
    const noPaths = await adapter.commit(root, { message: "x", paths: [] });
    expect(noPaths.ok).toBe(false);
    if (!noPaths.ok) expect(noPaths.error.kind).toBe("invalid_argument");
    const noMessage = await adapter.commit(root, { message: "  ", paths: ["README.md"] });
    expect(noMessage.ok).toBe(false);
    if (!noMessage.ok) expect(noMessage.error.kind).toBe("invalid_argument");
  });

  it("reports unknown declared paths as invalid_argument", async () => {
    const root = makeRepo();
    const result = await adapter.commit(root, {
      message: "harness: missing",
      paths: ["does-not-exist.txt"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_argument");
  });
});
