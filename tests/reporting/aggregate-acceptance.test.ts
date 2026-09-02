import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_CRITERIA,
  REQUIRED_SUITES,
  buildSuiteReport,
  criteriaForFile,
  mergeSuiteReports,
  reportPathForInvocation,
  resolveSuiteInvocation,
  suiteNameFromInvocation,
} from "./aggregate-acceptance.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = "2026-08-13T00:00:00.000Z";

describe("acceptance criteria registry", () => {
  it("covers exactly the 28 design criteria with unique ordered ids", () => {
    expect(ACCEPTANCE_CRITERIA).toHaveLength(28);
    ACCEPTANCE_CRITERIA.forEach((criterionEntry, index) => {
      expect(criterionEntry.id).toBe(`AC-${String(index + 1)}`);
    });
  });

  it("points every evidence prefix at an existing repository path", () => {
    for (const criterionEntry of ACCEPTANCE_CRITERIA) {
      for (const prefix of criterionEntry.evidence) {
        expect(existsSync(join(repositoryRoot, prefix)), prefix).toBe(true);
      }
    }
  });

  it("marks only AC-25 and AC-28 as gate-backed", () => {
    const gated = ACCEPTANCE_CRITERIA.filter((criterionEntry) => criterionEntry.gate !== undefined);
    expect(gated.map((criterionEntry) => criterionEntry.id)).toEqual(["AC-25", "AC-28"]);
  });

  it("requires the four release suites", () => {
    expect([...REQUIRED_SUITES]).toEqual(["main", "security", "fault", "performance"]);
  });
});

describe("suiteNameFromInvocation", () => {
  it("names the performance suite from its config file", () => {
    expect(suiteNameFromInvocation("/repo/vitest.performance.ts", [])).toBe("performance");
    expect(suiteNameFromInvocation(undefined, ["run", "--config", "vitest.performance.ts"])).toBe(
      "performance",
    );
  });

  it("names path-filtered suites from their filter arguments", () => {
    expect(suiteNameFromInvocation("/repo/vitest.workspace.ts", ["run", "tests/security"])).toBe(
      "security",
    );
    expect(suiteNameFromInvocation("/repo/vitest.workspace.ts", ["tests/fault"])).toBe("fault");
    expect(suiteNameFromInvocation("/repo/vitest.workspace.ts", ["tests/e2e"])).toBe("e2e");
  });

  it("defaults to the main suite for a full run and partial for unknown filters", () => {
    expect(
      suiteNameFromInvocation("/repo/vitest.workspace.ts", [
        "run",
        "--config",
        "vitest.workspace.ts",
      ]),
    ).toBe("main");
    expect(suiteNameFromInvocation("/repo/vitest.workspace.ts", ["tests/reporting"])).toBe(
      "partial",
    );
  });
});

describe("release suite provenance", () => {
  it("marks only the exact canonical command as full coverage", () => {
    expect(
      resolveSuiteInvocation("/repo/vitest.workspace.ts", [
        "run",
        "--config",
        "vitest.workspace.ts",
      ]),
    ).toEqual({ suite: "main", command: "pnpm test", coverage: "full" });
    expect(
      resolveSuiteInvocation("/repo/vitest.workspace.ts", [
        "run",
        "--config",
        "vitest.workspace.ts",
        "tests/reporting",
      ]),
    ).toMatchObject({ suite: "partial", coverage: "partial" });
  });

  it("keeps partial invocations in an identity-scoped path", () => {
    expect(
      reportPathForInvocation(
        { suite: "security", command: "pnpm test:security", coverage: "full" },
        "inv-full",
      ),
    ).toBe("security.json");
    expect(
      reportPathForInvocation(
        {
          suite: "security",
          command: "vitest run --config vitest.workspace.ts tests/security one.test.ts",
          coverage: "partial",
        },
        "inv-partial",
      ),
    ).toBe("partial/security-inv-partial.json");
  });
});

describe("buildSuiteReport", () => {
  it("maps executed files onto criteria and fails on any failed file", () => {
    const report = buildSuiteReport(
      "main",
      [
        { path: "tests/e2e/generic-new.test.ts", state: "pass" },
        { path: "tests/e2e/node-new.test.ts", state: "pass" },
        { path: "tests/e2e/python-new.test.ts", state: "pass" },
        { path: "tests/e2e/java-new.test.ts", state: "fail" },
      ],
      NOW,
      {
        schema_version: "harness.acceptance-suite-report/1",
        implementation_commit: "a".repeat(40),
        invocation_id: "inv-main",
        command: "pnpm test",
        coverage: "full",
      },
    );
    const ac1 = report.records.find((record) => record.criterion_id === "AC-1");
    expect(ac1?.status).toBe("failed");
    expect(ac1?.evidence).toContain("tests/e2e/java-new.test.ts");
    expect(report.files_failed).toBe(1);
    expect(report.criteria).toHaveLength(28);
    expect(report).toMatchObject({
      schema_version: "harness.acceptance-suite-report/1",
      implementation_commit: "a".repeat(40),
      invocation_id: "inv-main",
      command: "pnpm test",
      coverage: "full",
    });
  });

  it("skips criteria with no executed evidence and all gate-backed criteria", () => {
    const report = buildSuiteReport(
      "security",
      [{ path: "tests/security/secret-redaction.test.ts", state: "pass" }],
      NOW,
      {
        schema_version: "harness.acceptance-suite-report/1",
        implementation_commit: "a".repeat(40),
        invocation_id: "inv-security",
        command: "pnpm test:security",
        coverage: "full",
      },
    );
    expect(report.records.some((record) => record.criterion_id === "AC-12")).toBe(true);
    expect(report.records.some((record) => record.criterion_id === "AC-1")).toBe(false);
    expect(report.records.some((record) => record.criterion_id === "AC-25")).toBe(false);
    expect(report.records.some((record) => record.criterion_id === "AC-28")).toBe(false);
  });

  it("matches files to every criterion listing their prefix", () => {
    const matched = criteriaForFile("packages/runtime/test/context/compiler.test.ts");
    expect(matched.map((criterionEntry) => criterionEntry.id)).toEqual(["AC-10", "AC-11"]);
  });
});

describe("mergeSuiteReports", () => {
  it("lets the worst status win and accumulates evidence deterministically", () => {
    const main = buildSuiteReport(
      "main",
      [
        { path: "tests/e2e/generic-new.test.ts", state: "pass" },
        { path: "packages/runtime/test/tools/registry.test.ts", state: "pass" },
      ],
      NOW,
      {
        schema_version: "harness.acceptance-suite-report/1",
        implementation_commit: "a".repeat(40),
        invocation_id: "inv-main",
        command: "pnpm test",
        coverage: "full",
      },
    );
    const security = buildSuiteReport(
      "security",
      [{ path: "tests/security/secret-redaction.test.ts", state: "fail" }],
      NOW,
      {
        schema_version: "harness.acceptance-suite-report/1",
        implementation_commit: "a".repeat(40),
        invocation_id: "inv-security",
        command: "pnpm test:security",
        coverage: "full",
      },
    );
    const merged = mergeSuiteReports([main, security], NOW);
    const ac1 = merged.find((record) => record.criterion_id === "AC-1");
    const ac12 = merged.find((record) => record.criterion_id === "AC-12");
    const ac27 = merged.find((record) => record.criterion_id === "AC-27");
    expect(ac1?.status).toBe("passed");
    expect(ac12?.status).toBe("failed");
    expect(ac12?.evidence).toContain("tests/security/secret-redaction.test.ts");
    expect(ac27?.status).toBe("not_run");
  });

  it("keeps gate-backed criteria not_run for the generator to resolve", () => {
    const merged = mergeSuiteReports([], NOW);
    expect(merged.find((record) => record.criterion_id === "AC-25")?.status).toBe("not_run");
    expect(merged.find((record) => record.criterion_id === "AC-28")?.status).toBe("not_run");
  });
});
