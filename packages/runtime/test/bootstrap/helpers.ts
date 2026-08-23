import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";

import type { BootstrapDependencies, BootstrapIdKind } from "../../src/index.js";

export const FIXED_NOW = "2026-08-12T00:00:00.000Z";

const createdDirectories: string[] = [];

export function cleanupDirectories(): void {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function makeTempDir(prefix: string): string {
  // Git reports canonical paths; resolve symlinks (e.g. /var on macOS) so
  // tests can compare paths verbatim.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  createdDirectories.push(directory);
  return directory;
}

export function git(cwd: string, ...args: string[]): string {
  // Pin autocrlf off (Windows runners default it to true, which would dirty
  // clean repositories) and disable auto gc (no detached maintenance).
  const result = execFileSync("git", ["-c", "core.autocrlf=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (args[0] === "init") {
    for (const [key, value] of [
      ["user.name", "Harness Test"],
      ["user.email", "harness-test@example.invalid"],
      ["core.autocrlf", "false"],
      ["commit.gpgsign", "false"],
    ] as const) {
      execFileSync("git", ["config", "--local", key, value], { cwd });
    }
  }
  return result;
}

export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

/**
 * Initialize a repository on `main` with every given file committed. When
 * `leaf` is given the repository lives in a subdirectory with that fixed
 * name, so name-derived identities stay reproducible across runs.
 */
export function makeRepo(files: Readonly<Record<string, string>>, leaf?: string): string {
  const parent = makeTempDir("harness-runtime-");
  const root = leaf === undefined ? parent : join(parent, leaf);
  if (leaf !== undefined) mkdirSync(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness-test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeTree(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-m", "initial commit");
  return root;
}

export function headOf(root: string): string {
  return git(root, "rev-parse", "HEAD").trim();
}

/** Deterministic ids: `<kind>_t0001`, `<kind>_t0002`, ... per kind. */
export function sequentialIds(): (kind: BootstrapIdKind) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_t${String(next).padStart(4, "0")}`;
  };
}

export function makeDeps(): BootstrapDependencies {
  return {
    vcs: createGitVcsAdapter(),
    now: () => FIXED_NOW,
    newId: sequentialIds(),
  };
}
