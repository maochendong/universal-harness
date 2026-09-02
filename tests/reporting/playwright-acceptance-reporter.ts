import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import {
  reportPathForInvocation,
  resolvePlaywrightInvocation,
  SUITE_REPORT_SCHEMA_VERSION,
  type SuiteFileResult,
} from "./aggregate-acceptance.js";

/**
 * Release-aware Playwright reporter. The built-in JSON reporter does not bind
 * output to a Git commit or invocation identity, so it cannot be release
 * Evidence on its own.
 */
export default class PlaywrightAcceptanceReporter implements Reporter {
  private root = process.cwd();
  private startedCommit = "";
  private trackedCleanAtStart = false;
  private readonly results = new Map<string, { file: string; state: SuiteFileResult["state"] }>();

  onBegin(): void {
    this.startedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: this.root,
      encoding: "utf8",
    }).trim();
    this.trackedCleanAtStart =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: this.root,
        encoding: "utf8",
      }).trim() === "";
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const state: SuiteFileResult["state"] =
      result.status === "skipped"
        ? "skip"
        : result.status === test.expectedStatus
          ? "pass"
          : "fail";
    this.results.set(test.id, {
      file: relative(this.root, test.location.file).split(sep).join("/"),
      state,
    });
  }

  onEnd(result: FullResult): void {
    const invocation = resolvePlaywrightInvocation(process.argv.slice(2), this.root);
    const invocationId = randomUUID();
    const byFile = new Map<string, SuiteFileResult["state"]>();
    for (const entry of this.results.values()) {
      const previous = byFile.get(entry.file);
      byFile.set(
        entry.file,
        previous === "fail" || entry.state === "fail"
          ? "fail"
          : previous === "pass" || entry.state === "pass"
            ? "pass"
            : "skip",
      );
    }
    const files = [...byFile]
      .map(([path, state]) => ({ path, state }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const failedFiles = files.filter((file) => file.state === "fail").map((file) => file.path);
    const finishedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: this.root,
      encoding: "utf8",
    }).trim();
    const trackedCleanAtFinish =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: this.root,
        encoding: "utf8",
      }).trim() === "";
    const report = {
      schema_version: SUITE_REPORT_SCHEMA_VERSION,
      implementation_commit: this.startedCommit,
      started_commit: this.startedCommit,
      finished_commit: finishedCommit,
      tracked_worktree_clean_at_start: this.trackedCleanAtStart,
      tracked_worktree_clean_at_finish: trackedCleanAtFinish,
      tracked_worktree_clean:
        this.trackedCleanAtStart && trackedCleanAtFinish && this.startedCommit === finishedCommit,
      invocation_id: invocationId,
      ...invocation,
      recorded_at: new Date().toISOString(),
      files_total: files.length,
      files_failed: failedFiles.length,
      failed_files: failedFiles,
      files,
      records: [],
      criteria: [],
      status: result.status,
    };
    const reportsDirectory = join(this.root, ".reports", "acceptance");
    const outputPath = join(reportsDirectory, reportPathForInvocation(invocation, invocationId));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}
