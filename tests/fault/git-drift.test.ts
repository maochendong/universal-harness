import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BaselineMismatch,
  LedgerConflict,
  LedgerRepository,
  LedgerSequenceError,
  assertBaselineCompatible,
  mergeCommittedOperations,
} from "../../packages/core/src/index.js";
import { BASELINE, FIXED_NOW, makeInput } from "../../packages/core/test/ledger/fixtures.js";
import { WorkflowEngine } from "../../packages/runtime/src/index.js";
import { makeStartInput, phaseIds } from "../../packages/runtime/test/workflow/helpers.js";

/**
 * Git baseline drift fault injection (design 15.2: "Git Baseline Drift |
 * pause and recompute diff, impact and approval"). A commit whose expected
 * baseline no longer matches the repository HEAD is blocked with a typed
 * BaselineMismatch and changes nothing; a merge that brings in a conflicting
 * or forked operation is blocked instead of papered over by a union merge.
 */
const created: string[] = [];

function makeRoot(prefix = "harness-drift-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function git(cwd: string, ...args: string[]): string {
  // Pin autocrlf off: Windows CI runners default it to true, which would
  // rewrite line endings and dirty otherwise clean test repositories.
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
}

describe("git baseline drift", () => {
  it("blocks a ledger commit whose expected baseline drifted", async () => {
    const projectRoot = makeRoot();
    let head = "a".repeat(40);
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => head,
      now: () => FIXED_NOW,
    });
    await repository.commit(makeInput("ledger-op_drift01", { expected_baseline: head }));

    // The repository moved on (another commit landed): the old expectation
    // must fail closed with a typed error and no state change.
    head = "b".repeat(40);
    await expect(
      repository.commit(makeInput("ledger-op_drift02", { expected_baseline: "a".repeat(40) })),
    ).rejects.toBeInstanceOf(BaselineMismatch);
    expect(repository.operations()).toHaveLength(1);

    // Recomputing against the current head unblocks the commit.
    const outcome = await repository.commit(
      makeInput("ledger-op_drift02", { expected_baseline: "b".repeat(40) }),
    );
    expect(outcome.status).toBe("committed");
    expect(repository.operations()).toHaveLength(2);
  });

  it("records the exact baseline of every operation when the real git head drifts", async () => {
    const projectRoot = makeRoot("harness-drift-git-");
    git(projectRoot, "init", "--initial-branch", "main");
    git(
      projectRoot,
      "-c",
      "user.name=harness-test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "baseline",
    );
    const firstHead = git(projectRoot, "rev-parse", "HEAD").trim();
    let head = firstHead;

    const engine = new WorkflowEngine({
      projectRoot,
      readBaseline: () => head,
      now: () => FIXED_NOW,
      newId: phaseIds("drift"),
    });
    const started = await engine.startOperation(makeStartInput({ baselineCommit: firstHead }));
    const workflowOperationId = started.operation.workflow_operation_id;

    // Drift: an outside commit moves HEAD before the next state transition.
    writeFileSync(join(projectRoot, "outside.txt"), "external change");
    git(projectRoot, "add", "outside.txt");
    git(
      projectRoot,
      "-c",
      "user.name=harness-test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "external",
    );
    head = git(projectRoot, "rev-parse", "HEAD").trim();
    expect(head).not.toBe(firstHead);

    // The next transition commits against the current head, and the ledger
    // records the drift explicitly: each manifest carries the exact baseline
    // it was built on, so a later recompute can prove the operation chain
    // straddles the drift instead of silently rebasing history.
    await engine.advance(workflowOperationId, "planned");
    const baselines = new LedgerRepository({
      projectRoot,
      readBaseline: () => head,
    })
      .operations()
      .map((operation) => operation.manifest.baseline_commit);
    expect(baselines).toContain(firstHead);
    expect(baselines).toContain(head);
  });

  it("blocks operations targeting an unknown baseline chain", async () => {
    const projectRoot = makeRoot();
    let currentBaseline = "a".repeat(40);
    const repository = new LedgerRepository({
      projectRoot,
      readBaseline: () => currentBaseline,
      now: () => FIXED_NOW,
    });
    await repository.commit(makeInput("ledger-op_known", { expected_baseline: "a".repeat(40) }));
    currentBaseline = "f".repeat(40);
    await repository.commit(makeInput("ledger-op_unknown", { expected_baseline: "f".repeat(40) }));

    const operations = repository.operations();
    // A baseline chain that only knows the first commit rejects the drifted
    // operation instead of accepting an unreconciled history.
    const known = ["a".repeat(40)];
    expect(() =>
      assertBaselineCompatible(operations, (baseline) => known.includes(baseline)),
    ).toThrowError(BaselineMismatch);
    expect(() =>
      assertBaselineCompatible(operations, (baseline) =>
        ["a".repeat(40), "f".repeat(40)].includes(baseline),
      ),
    ).not.toThrow();
  });

  it("blocks merge-conflicting operation shards instead of union-merging them", async () => {
    const localRoot = makeRoot();
    const incomingRoot = makeRoot();
    const local = new LedgerRepository({
      projectRoot: localRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });
    const incoming = new LedgerRepository({
      projectRoot: incomingRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });
    await local.commit(makeInput("ledger-op_shared"));
    // Same operation id, different content: a digest conflict across branches.
    await incoming.commit(makeInput("ledger-op_shared", { attempt_id: "attempt_fork" }));
    expect(() => mergeCommittedOperations(local.operations(), incoming.operations())).toThrowError(
      LedgerConflict,
    );

    // Same sequence, different operation ids: a revision fork.
    const forkRoot = makeRoot();
    const fork = new LedgerRepository({
      projectRoot: forkRoot,
      readBaseline: () => BASELINE,
      now: () => FIXED_NOW,
    });
    await fork.commit(makeInput("ledger-op_other"));
    expect(() => mergeCommittedOperations(local.operations(), fork.operations())).toThrowError(
      LedgerSequenceError,
    );
  });
});
