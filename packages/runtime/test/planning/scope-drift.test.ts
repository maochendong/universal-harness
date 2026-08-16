import { describe, expect, it } from "vitest";

import { deriveActualRunChanges } from "../../src/planning/scope-drift.js";

describe("deriveActualRunChanges", () => {
  it("uses Harness VCS evidence and detects newly changed paths outside the grant", () => {
    const before = {
      from: "a".repeat(40),
      to: "worktree",
      files: [
        { path: "src/existing.ts", status: "modified" as const, insertions: 1, deletions: 0 },
      ],
      insertions: 1,
      deletions: 0,
    };
    const after = {
      from: "a".repeat(40),
      to: "worktree",
      files: [
        { path: "src/existing.ts", status: "modified" as const, insertions: 3, deletions: 1 },
        { path: "secrets.txt", status: "added" as const, insertions: 2, deletions: 0 },
        {
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed" as const,
          insertions: 0,
          deletions: 0,
        },
      ],
      insertions: 5,
      deletions: 1,
    };
    expect(deriveActualRunChanges(before, after, ["src"])).toEqual({
      change_summary: {
        files_changed: 3,
        insertions: 4,
        deletions: 1,
        paths: ["secrets.txt", "src/existing.ts", "src/new.ts"],
      },
      undeclared_writes: ["secrets.txt"],
      renamed_paths: [{ from: "src/old.ts", to: "src/new.ts" }],
      binary_paths: [],
    });
  });
});
