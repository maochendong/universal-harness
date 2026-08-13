import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitVcsAdapter } from "../src/adapter.js";

export const adapter = createGitVcsAdapter();

const createdDirectories: string[] = [];

export function cleanupDirectories(): void {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function git(cwd: string, ...args: string[]): string {
  // Pin autocrlf off: Windows CI runners default it to true, which would
  // rewrite line endings and dirty otherwise clean test repositories.
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
}

export function makeTempDir(prefix: string): string {
  // Git reports canonical paths; resolve symlinks (e.g. /var on macOS) so
  // tests can compare paths verbatim.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  createdDirectories.push(directory);
  return directory;
}

/** Initialize a repository on `main` with one committed file. */
export function makeRepo(): string {
  const root = makeTempDir("harness-vcs-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness-test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "initial\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "initial commit");
  return root;
}

export function headOf(root: string): string {
  return git(root, "rev-parse", "HEAD").trim();
}

export function writeRepoFile(root: string, path: string, content: string): void {
  writeFileSync(join(root, path), content);
}
