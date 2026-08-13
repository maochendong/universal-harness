import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MANAGED_DIRECTORIES,
  MANAGED_GITATTRIBUTES_CONTENT,
  MANAGED_GITATTRIBUTES_RELATIVE_PATH,
  MANAGED_GITIGNORE_CONTENT,
  MANAGED_GITIGNORE_RELATIVE_PATH,
  MANIFEST_RELATIVE_PATH,
  ManagedFileConflictError,
  ProjectLayoutError,
  createPackLock,
  createProjectManifest,
  findProjectRoot,
  initializeManagedLayout,
  readManagedManifest,
  readManagedPackLock,
} from "../../src/index.js";

const fixedNow = () => "2026-08-12T00:00:00.000Z";

const createdRoots: string[] = [];

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-project-"));
  createdRoots.push(root);
  return root;
}

function init(root: string) {
  return initializeManagedLayout({
    projectRoot: root,
    manifest: createProjectManifest({ name: "demo", repositoryId: "repo.demo", now: fixedNow }),
    packLock: createPackLock([{ name: "pack-generic", version: "0.1.0", digest: "a".repeat(64) }]),
  });
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined)
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("managed project layout", () => {
  it("initializes every managed directory and file inside .harness only", () => {
    const root = makeProjectRoot();
    const outcome = init(root);
    expect(outcome.reused).toEqual([]);
    expect(outcome.created).toEqual([
      MANIFEST_RELATIVE_PATH,
      "harness.lock",
      MANAGED_GITIGNORE_RELATIVE_PATH,
      MANAGED_GITATTRIBUTES_RELATIVE_PATH,
    ]);
    for (const directory of MANAGED_DIRECTORIES) {
      expect(statSync(join(root, ".harness", directory)).isDirectory(), directory).toBe(true);
    }
    expect(readFileSync(join(root, ".harness", MANAGED_GITIGNORE_RELATIVE_PATH), "utf8")).toBe(
      MANAGED_GITIGNORE_CONTENT,
    );
    expect(readFileSync(join(root, ".harness", MANAGED_GITATTRIBUTES_RELATIVE_PATH), "utf8")).toBe(
      MANAGED_GITATTRIBUTES_CONTENT,
    );
    expect(readManagedManifest(root).name).toBe("demo");
    expect(readManagedPackLock(root).packs).toHaveLength(1);
  });

  it("excludes local-only state and forbids text merges of ledger shards", () => {
    for (const excluded of ["cache/", "staging/", "raw-traces/", "generated/providers/"]) {
      expect(MANAGED_GITIGNORE_CONTENT).toContain(excluded);
    }
    expect(MANAGED_GITATTRIBUTES_CONTENT).toContain("ledger/** -merge");
    expect(MANAGED_GITATTRIBUTES_CONTENT).toContain("events/** -merge");
    expect(MANAGED_GITATTRIBUTES_CONTENT).not.toContain("union");
  });

  it("is idempotent and blocks on diverging managed content", () => {
    const root = makeProjectRoot();
    init(root);
    const second = init(root);
    expect(second.created).toEqual([]);
    expect(second.reused).toHaveLength(4);
    writeFileSync(join(root, ".harness", MANAGED_GITIGNORE_RELATIVE_PATH), "user edit\n", "utf8");
    expect(() => init(root)).toThrow(ManagedFileConflictError);
  });

  it("locates the project root from nested directories", () => {
    const root = makeProjectRoot();
    init(root);
    expect(findProjectRoot(join(root, ".harness", "artifacts", "tasks"))).toBe(root);
    expect(findProjectRoot(root)).toBe(root);
    expect(findProjectRoot(makeProjectRoot())).toBeUndefined();
  });

  it("reads fail with typed errors outside managed projects", () => {
    const root = makeProjectRoot();
    expect(() => readManagedManifest(root)).toThrow(ProjectLayoutError);
    expect(() => readManagedPackLock(root)).toThrow(ProjectLayoutError);
  });
});
