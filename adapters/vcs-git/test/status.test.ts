import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseGitDiffStat } from "../src/status.js";

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

describe("parseGitDiffStat", () => {
  it("preserves deletes, renames, spaces, binary markers and untracked files", () => {
    const files = parseGitDiffStat(
      "M\0src/app.ts\0D\0old file.txt\0R100\0before.ts\0after name.ts\0M\0image.bin\0",
      [
        "3\t1\tsrc/app.ts",
        "0\t2\told file.txt",
        "0\t0\t",
        "before.ts",
        "after name.ts",
        "-\t-\timage.bin",
        "",
      ].join("\0"),
      [
        { path: "new file.txt", insertions: 2, binary: false },
        { path: "raw.bin", insertions: 0, binary: true },
      ],
    );
    expect(files).toHaveLength(6);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "after name.ts",
          previousPath: "before.ts",
          status: "renamed",
        }),
        expect.objectContaining({ path: "image.bin", binary: true, insertions: 0, deletions: 0 }),
        expect.objectContaining({ path: "new file.txt", status: "added", insertions: 2 }),
        expect.objectContaining({ path: "old file.txt", status: "deleted", deletions: 2 }),
        expect.objectContaining({ path: "raw.bin", status: "added", binary: true }),
        expect.objectContaining({
          path: "src/app.ts",
          status: "modified",
          insertions: 3,
          deletions: 1,
        }),
      ]),
    );
  });
});
