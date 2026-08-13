import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PolicyError, assertWithinRepositoryBoundary } from "../../packages/runtime/src/index.js";

/**
 * Symlink escape security invariants (design 14; security test list). The
 * repository boundary check resolves every existing ancestor through
 * realpath, so a symlink inside the repository -- whether it points at a
 * directory or a single file, directly or through nesting -- can never be
 * used to read or write outside the repository root.
 */
const created: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function makeRepository(): { root: string; outside: string } {
  const root = makeTempDir("harness-symlink-repo-");
  const outside = makeTempDir("harness-symlink-outside-");
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "src", "ok.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "do not touch");
  return { root, outside };
}

describe("symlink escape", () => {
  it("rejects a symlinked directory that points outside the repository", () => {
    const { root, outside } = makeRepository();
    symlinkSync(outside, join(root, "src", "escape"));
    expect(() => assertWithinRepositoryBoundary(root, "src/escape/secret.txt")).toThrowError(
      PolicyError,
    );
    expect(() => assertWithinRepositoryBoundary(root, "src/escape/new-file.txt")).toThrowError(
      PolicyError,
    );
  });

  it("rejects a symlinked file that points outside the repository", () => {
    const { root, outside } = makeRepository();
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "linked-secret.txt"));
    expect(() => assertWithinRepositoryBoundary(root, "src/linked-secret.txt")).toThrowError(
      PolicyError,
    );
  });

  it("rejects a nested path that escapes through a symlink midway", () => {
    const { root, outside } = makeRepository();
    symlinkSync(outside, join(root, "src", "nested", "midway"));
    expect(() =>
      assertWithinRepositoryBoundary(root, "src/nested/midway/deeper/secret.txt"),
    ).toThrowError(PolicyError);
  });

  it("allows symlinks that stay inside the repository", () => {
    const { root } = makeRepository();
    mkdirSync(join(root, "docs"), { recursive: true });
    symlinkSync(join(root, "docs"), join(root, "src", "docs-link"));
    const resolved = assertWithinRepositoryBoundary(root, "src/docs-link");
    expect(resolved).toContain("src");
    // Ordinary reads and writes inside the root keep working.
    expect(assertWithinRepositoryBoundary(root, "src/ok.txt")).toContain("src");
    expect(assertWithinRepositoryBoundary(root, "src/nested/new-file.txt")).toContain("nested");
  });
});
