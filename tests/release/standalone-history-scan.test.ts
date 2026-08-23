import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanStandaloneRepository } from "../../scripts/standalone-scan.mjs";

const roots: string[] = [];
const LEGACY_PATH = "docs/legacy-product-evolution.md";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function makeRemediatedRepository(): {
  readonly cwd: string;
  readonly historicalCommit: string;
  readonly historicalBlob: string;
} {
  const cwd = mkdtempSync(join(tmpdir(), "harness-standalone-"));
  roots.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Harness Test");
  git(cwd, "config", "user.email", "harness-test@example.invalid");
  git(cwd, "config", "core.autocrlf", "false");
  writeFileSync(join(cwd, "README.md"), "# Independent product\n", "utf8");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-m", "initial");
  mkdirSync(join(cwd, "docs"));
  writeFileSync(
    join(cwd, LEGACY_PATH),
    `Formerly powered by ${["Code", "Buddy"].join("")}.\n`,
    "utf8",
  );
  const historicalCommit = commit(cwd, "add migration history");
  const historicalBlob = git(cwd, "rev-parse", `${historicalCommit}:${LEGACY_PATH}`);
  git(cwd, "rm", LEGACY_PATH);
  commit(cwd, "remove former-product document");
  return { cwd, historicalCommit, historicalBlob };
}

function exactException(input: {
  readonly historicalCommit: string;
  readonly historicalBlob: string;
}) {
  return {
    commit: input.historicalCommit,
    path: LEGACY_PATH,
    blob_digest: input.historicalBlob,
    reason: "immutable pre-remediation migration document",
  } as const;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scanStandaloneRepository", () => {
  it("accepts only the exact historical commit, path and blob exception", () => {
    const repository = makeRemediatedRepository();

    expect(
      scanStandaloneRepository({
        cwd: repository.cwd,
        exceptions: [exactException(repository)],
      }),
    ).toEqual([]);
  });

  it("rejects a new historical former-product brand even when the old tuple is excepted", () => {
    const repository = makeRemediatedRepository();
    const secondPath = join(repository.cwd, "docs", "retrospective.md");
    mkdirSync(join(repository.cwd, "docs"));
    writeFileSync(
      secondPath,
      `${["Code", "Buddy"].join("")} remains the product identity.\n`,
      "utf8",
    );
    commit(repository.cwd, "add a new branded record");
    git(repository.cwd, "rm", "docs/retrospective.md");
    commit(repository.cwd, "remove new branded record");

    expect(
      scanStandaloneRepository({
        cwd: repository.cwd,
        exceptions: [exactException(repository)],
      }),
    ).toContainEqual(expect.stringContaining("forbidden former-product brand"));
  });

  it("does not treat a path, blob or commit near-match as an exception", () => {
    const repository = makeRemediatedRepository();
    const base = exactException(repository);

    for (const exception of [
      { ...base, commit: "0".repeat(40) },
      { ...base, path: "docs/other.md" },
      { ...base, blob_digest: "0".repeat(40) },
    ]) {
      expect(
        scanStandaloneRepository({ cwd: repository.cwd, exceptions: [exception] }),
      ).toContainEqual(expect.stringContaining("forbidden former-product brand"));
    }
  });
});
