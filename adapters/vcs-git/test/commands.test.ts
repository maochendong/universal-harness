import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "../src/adapter.js";
import { adapter, cleanupDirectories, makeRepo, makeTempDir } from "./helpers.js";

afterEach(cleanupDirectories);

describe("git command normalization", () => {
  it("reports executable_unavailable when git cannot be spawned", async () => {
    const broken = createGitVcsAdapter({ executable: "harness-git-that-does-not-exist" });
    const root = makeRepo();
    const result = await broken.status(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("executable_unavailable");
  });

  it("reports command failures with stderr and exit code", async () => {
    const root = makeRepo();
    // Creating a branch that already exists fails with exit code 128.
    const result = await adapter.createBranch(root, "main");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("command_failed");
    expect(result.error.stderr).toBeDefined();
    expect(result.error.exitCode).toBe(128);
  });

  it("reports not_a_repository for operations outside a repository", async () => {
    const outside = makeTempDir("harness-vcs-outside-");
    const result = await adapter.status(outside);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("not_a_repository");
  });
});
