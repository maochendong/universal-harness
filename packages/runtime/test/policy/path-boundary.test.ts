import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PolicyError } from "../../src/policy/action.js";
import {
  assertWithinRepositoryBoundary,
  isPathWithinScopes,
  normalizeRepoRelativePath,
} from "../../src/policy/path-boundary.js";

describe("normalizeRepoRelativePath", () => {
  it("normalizes separators and dot segments", () => {
    expect(normalizeRepoRelativePath("src\\nested\\file.ts")).toBe("src/nested/file.ts");
    expect(normalizeRepoRelativePath("./src/./file.ts")).toBe("src/file.ts");
  });

  it("rejects traversal, absolute paths, drive prefixes and empty segments", () => {
    expect(() => normalizeRepoRelativePath("../outside.ts")).toThrowError(PolicyError);
    expect(() => normalizeRepoRelativePath("src/../../outside.ts")).toThrowError(PolicyError);
    expect(() => normalizeRepoRelativePath("/etc/passwd")).toThrowError(PolicyError);
    expect(() => normalizeRepoRelativePath("C:/windows")).toThrowError(PolicyError);
    expect(() => normalizeRepoRelativePath("src//file.ts")).toThrowError(PolicyError);
    expect(() => normalizeRepoRelativePath("")).toThrowError(PolicyError);
  });
});

describe("isPathWithinScopes", () => {
  it("matches a scope itself and everything below it, nothing beside it", () => {
    const scopes = ["src", "docs/guide.md"];
    expect(isPathWithinScopes(scopes, "src")).toBe(true);
    expect(isPathWithinScopes(scopes, "src/nested/file.ts")).toBe(true);
    expect(isPathWithinScopes(scopes, "docs/guide.md")).toBe(true);
    expect(isPathWithinScopes(scopes, "docs/other.md")).toBe(false);
    expect(isPathWithinScopes(scopes, "src-other/file.ts")).toBe(false);
    expect(isPathWithinScopes(scopes, "../src/file.ts")).toBe(false);
  });
});

describe("assertWithinRepositoryBoundary", () => {
  let root = "";

  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    root = "";
  });

  function makeRepository(): string {
    root = mkdtempSync(join(tmpdir(), "harness-policy-boundary-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export {};\n");
    return root;
  }

  it("resolves legitimate paths, including ones that do not exist yet", () => {
    const repository = makeRepository();
    expect(assertWithinRepositoryBoundary(repository, "src/index.ts")).toBe(
      join(realpathSync(repository), "src", "index.ts"),
    );
    expect(assertWithinRepositoryBoundary(repository, "src/new/deep/file.ts")).toContain("src");
  });

  it("rejects traversal before touching the filesystem", () => {
    const repository = makeRepository();
    expect(() => assertWithinRepositoryBoundary(repository, "../outside.ts")).toThrowError(
      PolicyError,
    );
  });

  it("rejects a symlink that escapes the repository, even for new files below it", () => {
    const repository = makeRepository();
    const outside = mkdtempSync(join(tmpdir(), "harness-policy-outside-"));
    writeFileSync(join(outside, "secret.txt"), "shhh");
    symlinkSync(outside, join(repository, "link"));
    expect(() => assertWithinRepositoryBoundary(repository, "link/secret.txt")).toThrowError(
      PolicyError,
    );
    expect(() => assertWithinRepositoryBoundary(repository, "link/new-file.txt")).toThrowError(
      PolicyError,
    );
    rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("accepts a symlink that stays inside the repository", () => {
    const repository = makeRepository();
    symlinkSync(join(repository, "src"), join(repository, "alias"));
    expect(assertWithinRepositoryBoundary(repository, "alias/index.ts")).toContain("alias");
  });
});
