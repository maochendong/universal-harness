import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { adapter, cleanupDirectories, git, makeRepo, writeRepoFile } from "./helpers.js";

afterEach(cleanupDirectories);

describe("status", () => {
  it("reports a clean repository", async () => {
    const root = makeRepo();
    const result = await adapter.status(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clean).toBe(true);
    expect(result.value.branch).toBe("main");
    expect(result.value.staged).toEqual([]);
    expect(result.value.unstaged).toEqual([]);
    expect(result.value.untracked).toEqual([]);
  });

  it("reports unstaged modifications to tracked files", async () => {
    const root = makeRepo();
    writeRepoFile(root, "README.md", "changed\n");
    const result = await adapter.status(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clean).toBe(false);
    expect(result.value.unstaged).toEqual(["README.md"]);
    expect(result.value.staged).toEqual([]);
  });

  it("reports staged additions and untracked files", async () => {
    const root = makeRepo();
    writeRepoFile(root, "staged.ts", "export {};\n");
    git(root, "add", "staged.ts");
    writeRepoFile(root, "scratch.ts", "export {};\n");
    const result = await adapter.status(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.staged).toEqual(["staged.ts"]);
    expect(result.value.untracked).toEqual(["scratch.ts"]);
  });

  it("reports staged renames with the new path", async () => {
    const root = makeRepo();
    mkdirSync(join(root, "docs"));
    git(root, "mv", "README.md", "docs/README.md");
    const result = await adapter.status(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.staged).toEqual(["docs/README.md"]);
  });
});
