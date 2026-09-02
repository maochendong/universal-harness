/**
 * Vitest acceptance reporter (M1 plan Task 28 step 4).
 *
 * Registered alongside the default reporter in every vitest config. At the
 * end of a run it maps the executed test files onto the M1 acceptance
 * criteria registry and writes the structured suite report to
 * `.reports/acceptance/<suite>.json` (gitignored). The release aggregation
 * (`scripts/generate-acceptance-report.mjs`) merges these files into
 * `docs/m1-acceptance-report.md`; neither the reporter nor the generator
 * ever rewrites a recorded result.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { Reporter, TestModule, Vitest } from "vitest/node";

import {
  buildSuiteReport,
  reportPathForInvocation,
  resolveSuiteInvocation,
  SUITE_REPORT_SCHEMA_VERSION,
  type SuiteFileResult,
} from "./aggregate-acceptance.js";

function fileResults(root: string, modules: ReadonlyArray<TestModule>): SuiteFileResult[] {
  const results: SuiteFileResult[] = [];
  for (const module of modules) {
    const relativePath = relative(root, module.moduleId).split(sep).join("/");
    const state = module.task.result?.state;
    results.push({
      path: relativePath,
      state: state === "fail" ? "fail" : state === "pass" ? "pass" : "skip",
    });
  }
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

export default class AcceptanceReporter implements Reporter {
  private ctx!: Vitest;
  private startedCommit = "";
  private trackedCleanAtStart = false;

  onInit(ctx: Vitest): void {
    this.ctx = ctx;
    this.startedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ctx.config.root,
      encoding: "utf8",
    }).trim();
    this.trackedCleanAtStart =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: ctx.config.root,
        encoding: "utf8",
      }).trim() === "";
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const root = this.ctx.config.root;
    const invocation = resolveSuiteInvocation(
      this.ctx.config.configFile,
      process.argv.slice(2),
      root,
    );
    const invocationId = randomUUID();
    const trackedStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const finishedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const report = buildSuiteReport(
      invocation.suite,
      fileResults(root, modules),
      new Date().toISOString(),
      {
        schema_version: SUITE_REPORT_SCHEMA_VERSION,
        implementation_commit: this.startedCommit,
        started_commit: this.startedCommit,
        finished_commit: finishedCommit,
        tracked_worktree_clean_at_start: this.trackedCleanAtStart,
        tracked_worktree_clean_at_finish: trackedStatus === "",
        tracked_worktree_clean:
          this.trackedCleanAtStart && trackedStatus === "" && this.startedCommit === finishedCommit,
        invocation_id: invocationId,
        ...invocation,
      },
    );
    const directory = join(root, ".reports", "acceptance");
    const outputPath = join(directory, reportPathForInvocation(invocation, invocationId));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}
