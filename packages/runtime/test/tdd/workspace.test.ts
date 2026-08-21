import { describe, expect, it } from "vitest";

import { createInMemoryWorkspacePort, type PatchFile } from "../../src/tdd/workspace.js";
import {
  attestWriteSet,
  canonicalTestPatch,
  validateTestAuthoringPatch,
} from "../../src/tdd/patch.js";

/**
 * T15 isolated workspaces (provable TDD design 8.2): every phase workspace
 * rebuilds reproducibly from the bound baseline; a test-authoring workspace
 * never leaks transient state into the red-verification workspace; the
 * extracted patch validates against the path policy, and a write outside
 * the granted scope is caught by attestation.
 */
const BASELINE_FILES: Record<string, string> = {
  "src/items.ts": "export const items = [];",
  "tests/items.test.ts": "// placeholder",
};

describe("in-memory isolated workspace port", () => {
  it("rebuilds identical workspaces from the same baseline", async () => {
    const port = createInMemoryWorkspacePort(BASELINE_FILES, { baseline_commit: "deadbeef" });
    const first = await port.create({ baseline_commit: "deadbeef", purpose: "baseline" });
    const second = await port.create({ baseline_commit: "deadbeef", purpose: "test_authoring" });
    expect(first.files_digest).toBe(second.files_digest);
    expect(first.workspace_id).not.toBe(second.workspace_id);
    expect(await port.diff(first)).toEqual([]);
  });

  it("never leaks test-authoring state into a fresh red workspace", async () => {
    const port = createInMemoryWorkspacePort(BASELINE_FILES, { baseline_commit: "deadbeef" });
    const authoring = await port.create({ baseline_commit: "deadbeef", purpose: "test_authoring" });
    await port.applyFiles(authoring, [
      { path: "tests/items.test.ts", content: "the real test" },
      { path: "scratch.tmp", content: "transient" },
    ]);
    const patch = await port.diff(authoring);
    expect(patch.map((file) => file.path)).toContain("tests/items.test.ts");

    const red = await port.create({ baseline_commit: "deadbeef", purpose: "red_verification" });
    expect(await port.diff(red)).toEqual([]);
    const patchDigest = canonicalTestPatch(patch.filter((file) => file.path.endsWith(".ts")));
    await port.applyFiles(
      red,
      patch.filter((file) => file.path.endsWith(".ts")),
    );
    expect(canonicalTestPatch(await port.diff(red)).patch_digest).toBe(patchDigest.patch_digest);
  });

  it("rejects a patch touching production during test authoring", async () => {
    const port = createInMemoryWorkspacePort(BASELINE_FILES, { baseline_commit: "deadbeef" });
    const authoring = await port.create({ baseline_commit: "deadbeef", purpose: "test_authoring" });
    await port.applyFiles(authoring, [{ path: "src/items.ts", content: "hacked" }]);
    const patch = await port.diff(authoring);
    const policy = { test: ["tests/**"], test_config: [], production: ["src/**"], immutable: [] };
    expect(validateTestAuthoringPatch(patch, policy).map((issue) => issue.code)).toContain(
      "production_write",
    );
    expect(
      attestWriteSet(
        patch.map((file) => file.path),
        ["tests/**"],
      ),
    ).toContain("src/items.ts");
  });

  it("discards a failed refactor back to the verified baseline state", async () => {
    const port = createInMemoryWorkspacePort(BASELINE_FILES, { baseline_commit: "deadbeef" });
    const workspace = await port.create({ baseline_commit: "deadbeef", purpose: "refactor" });
    await port.applyFiles(workspace, [
      { path: "src/items.ts", content: "broken refactor" } as PatchFile,
    ]);
    expect((await port.diff(workspace)).length).toBeGreaterThan(0);
    await port.reset(workspace);
    expect(await port.diff(workspace)).toEqual([]);
  });
});
