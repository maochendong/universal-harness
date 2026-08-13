import type { PluginKind } from "@universal-harness-internal/plugin-sdk";

/**
 * Shared conformance runner (plan Task 24 step 4). Every first-party adapter
 * and pack proves the same versioned contract by running one suite of named
 * cases through this runner. Cases execute in declared order; a throwing case
 * is recorded as a failure with its message and never aborts the suite, so a
 * report always covers every case. The runner itself is transport-agnostic:
 * cases are plain functions, assertions live in `assertions.ts`, fixtures in
 * `fixtures.ts`.
 */

export interface ConformanceCase {
  readonly name: string;
  /** Throws (or rejects) to fail the case. */
  run(): void | Promise<void>;
}

export interface ConformanceSuite {
  /** Plugin under test, e.g. `adapter-vcs-git`. */
  readonly plugin: string;
  readonly kind: PluginKind;
  readonly cases: readonly ConformanceCase[];
}

export interface ConformanceCaseResult {
  readonly name: string;
  readonly passed: boolean;
  /** Failure message when the case threw. */
  readonly error?: string;
}

export interface ConformanceReport {
  readonly plugin: string;
  readonly kind: PluginKind;
  readonly results: readonly ConformanceCaseResult[];
  readonly total: number;
  readonly failed: number;
  readonly passed: boolean;
}

export class ConformanceError extends Error {
  readonly report: ConformanceReport;

  constructor(report: ConformanceReport) {
    const failures = report.results
      .filter((result) => !result.passed)
      .map((result) => `- ${result.name}: ${result.error ?? "failed"}`)
      .join("\n");
    super(
      `conformance suite "${report.plugin}" (${report.kind}) failed ${String(report.failed)} of ${String(report.total)} cases:\n${failures}`,
    );
    this.name = "ConformanceError";
    this.report = report;
  }
}

/** Run every case in order and collect a deterministic report. */
export async function runConformanceSuite(suite: ConformanceSuite): Promise<ConformanceReport> {
  const results: ConformanceCaseResult[] = [];
  for (const conformanceCase of suite.cases) {
    try {
      await conformanceCase.run();
      results.push({ name: conformanceCase.name, passed: true });
    } catch (error) {
      results.push({
        name: conformanceCase.name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failed = results.filter((result) => !result.passed).length;
  return {
    plugin: suite.plugin,
    kind: suite.kind,
    results,
    total: results.length,
    failed,
    passed: failed === 0,
  };
}

/**
 * Return the report when every case passed; otherwise throw a typed
 * `ConformanceError` listing each failure.
 */
export function assertConformance(report: ConformanceReport): ConformanceReport {
  if (!report.passed) throw new ConformanceError(report);
  return report;
}
