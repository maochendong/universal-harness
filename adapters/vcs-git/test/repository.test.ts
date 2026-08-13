import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  adapter,
  cleanupDirectories,
  expectSameDirectory,
  headOf,
  makeRepo,
  makeTempDir,
} from "./helpers.js";

afterEach(cleanupDirectories);

describe("detectRepository", () => {
  it("detects a repository from its root", async () => {
    const root = makeRepo();
    const result = await adapter.detectRepository(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectSameDirectory(result.value.root, root);
    expect(result.value.head).toBe(headOf(root));
    expect(result.value.branch).toBe("main");
  });

  it("detects a repository from a nested subdirectory", async () => {
    const root = makeRepo();
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    const result = await adapter.detectRepository(nested);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectSameDirectory(result.value.root, root);
  });

  it("reports a typed error outside any repository", async () => {
    const outside = makeTempDir("harness-vcs-outside-");
    const result = await adapter.detectRepository(outside);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("not_a_repository");
    expect(result.error.operation).toBe("detectRepository");
  });
});

describe("initRepository", () => {
  it("initializes a repository on the requested initial branch", async () => {
    const root = makeTempDir("harness-vcs-init-");
    const result = await adapter.initRepository(root, { initialBranch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectSameDirectory(result.value.root, root);
    expect(result.value.branch).toBe("main");
    expect(result.value.head).toBeNull();
    const detected = await adapter.detectRepository(root);
    expect(detected.ok).toBe(true);
  });

  it("initializes a repository with the git default branch when none is given", async () => {
    const root = makeTempDir("harness-vcs-init-default-");
    const result = await adapter.initRepository(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value.branch).toBe("string");
  });
});

describe("baselineCommit", () => {
  it("returns the current HEAD commit hash", async () => {
    const root = makeRepo();
    const result = await adapter.baselineCommit(root);
    expect(result).toEqual({ ok: true, value: headOf(root) });
  });

  it("reports ref_not_found on an unborn branch", async () => {
    const empty = makeTempDir("harness-vcs-empty-");
    execFileSync("git", ["init", "-b", "main"], { cwd: empty });
    const result = await adapter.baselineCommit(empty);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("ref_not_found");
  });
});
