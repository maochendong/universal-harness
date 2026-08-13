import { describe, expect, it } from "vitest";

import {
  LedgerPathError,
  resolveHarnessPath,
  validateTransaction,
} from "../../packages/core/src/index.js";
import { makeEdge, makeEvent } from "../../packages/core/test/ledger/fixtures.js";
import {
  PolicyError,
  assertWithinRepositoryBoundary,
  isPathWithinScopes,
  managedProjectionPath,
  normalizeRepoRelativePath,
  ProjectionError,
  tryNormalizeRepoRelativePath,
} from "../../packages/runtime/src/index.js";

/**
 * Path traversal security invariants (design 14; security test list). Every
 * path language in the system -- ledger-relative, repository-relative,
 * projection output names and ledger artifact paths -- rejects traversal
 * segments, absolute paths, drive prefixes, NUL bytes and separator tricks
 * before any byte is addressed on disk.
 */
const HARNESS_ROOT = "/virtual/harness";

describe("ledger-relative path traversal", () => {
  it("rejects every escape form before resolving anything", () => {
    const escapes = [
      "../outside",
      "a/../../b",
      "/absolute/path",
      "a//b",
      "a/./b",
      "a\\..\\b",
      `a${String.fromCharCode(0)}b`,
      "",
    ];
    for (const escape of escapes) {
      expect(() => resolveHarnessPath(HARNESS_ROOT, escape), escape).toThrowError(LedgerPathError);
    }
    expect(resolveHarnessPath(HARNESS_ROOT, "artifacts/nodes/node_01.json")).toContain("artifacts");
  });
});

describe("ledger artifact path traversal", () => {
  it("rejects traversal, reserved prefixes and duplicates at validation time", () => {
    const base = {
      ledger_operation_id: "ledger-op_sec01",
      workflow_operation_id: "workflow-op_sec01",
      attempt_id: "attempt_sec01",
      expected_baseline: "0123456789abcdef",
      edges: [makeEdge("edge_sec01")],
      events: [makeEvent("event_sec01", "ledger-op_sec01", 1)],
    };
    const illegal = [
      "../evil.json",
      "a/../../evil.json",
      "ledger/operations/ledger-op_other.json",
      "events/2026-08/ledger-op_other.jsonl",
      "staging/ledger-op_other/x",
      "locks/write.lock",
      "cache/graph.sqlite",
      "a//b.json",
    ];
    for (const path of illegal) {
      const issues = validateTransaction({
        ...base,
        artifacts: [{ path, content: "{}\n" }],
      });
      expect(issues.length, path).toBeGreaterThan(0);
    }
    const duplicates = validateTransaction({
      ...base,
      artifacts: [
        { path: "nodes/a.json", content: "{}\n" },
        { path: "nodes/a.json", content: "{}\n" },
      ],
    });
    expect(duplicates.some((issue) => issue.keyword === "uniqueItems")).toBe(true);
  });
});

describe("repository-relative path traversal", () => {
  it("rejects traversal, absolute, drive-prefixed and separator tricks", () => {
    const rejected = [
      "../etc/passwd",
      "src/../../etc/passwd",
      "/etc/passwd",
      "C:/windows/system32",
      "src//main.ts",
      "src\\..\\secrets",
      "..",
    ];
    for (const path of rejected) {
      expect(tryNormalizeRepoRelativePath(path), path).toBeUndefined();
      expect(() => normalizeRepoRelativePath(path), path).toThrowError(PolicyError);
    }
    expect(normalizeRepoRelativePath("src/./main.ts")).toBe("src/main.ts");
  });

  it("never treats a rejected path as within scope", () => {
    expect(isPathWithinScopes(["src"], "src/../secrets/deploy.key")).toBe(false);
    expect(isPathWithinScopes(["src"], "../src/main.ts")).toBe(false);
    expect(isPathWithinScopes(["src"], "src/main.ts")).toBe(true);
  });

  it("rejects traversal before any filesystem access", () => {
    expect(() =>
      assertWithinRepositoryBoundary("/definitely/not/a/repository", "../escape"),
    ).toThrowError(PolicyError);
  });
});

describe("projection output path traversal", () => {
  it("confines managed projection names to the managed root", () => {
    const escapes = ["../escape.md", "views/../../escape.md", "a\\b.md", "/abs.md", "views/"];
    for (const name of escapes) {
      expect(() => managedProjectionPath(name), name).toThrowError(ProjectionError);
    }
    expect(managedProjectionPath("views/prd.md")).toBe("projections/views/prd.md");
  });
});
