import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectDoctorProbes,
  evaluateDoctorDiagnostics,
  type DoctorProbes,
} from "../../src/doctor/doctor.js";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "harness-doctor-"));
  created.push(directory);
  return directory;
}

const HEALTHY: DoctorProbes = {
  nodeVersion: "v22.13.0",
  gitVersion: "git version 2.50.0",
  project: {
    projectRoot: "/repo",
    projectName: "demo",
    packCount: 1,
    cache: { status: "ok" },
  },
};

describe("evaluateDoctorDiagnostics", () => {
  it("passes a healthy environment and project", () => {
    const report = evaluateDoctorDiagnostics(HEALTHY);
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.diagnostics.every((diagnostic) => diagnostic.status === "pass")).toBe(true);
  });

  it("fails with a remedy when the Node runtime is too old", () => {
    const report = evaluateDoctorDiagnostics({ ...HEALTHY, nodeVersion: "v20.11.0" });
    const check = report.diagnostics.find((diagnostic) => diagnostic.name === "node_runtime");
    expect(check?.status).toBe("fail");
    expect(check?.category).toBe("environment");
    expect(check?.remedy).toContain("22.13.0");
    expect(report.ok).toBe(false);
  });

  it("fails when the git executable is unavailable", () => {
    const report = evaluateDoctorDiagnostics({ nodeVersion: "v22.13.0" });
    const check = report.diagnostics.find((diagnostic) => diagnostic.name === "git_executable");
    expect(check?.status).toBe("fail");
    expect(check?.category).toBe("git");
    expect(check?.remedy).toContain("git");
  });

  it("skips project checks outside a managed project", () => {
    const report = evaluateDoctorDiagnostics({
      nodeVersion: "v22.13.0",
      gitVersion: "git version 2.50.0",
    });
    const check = report.diagnostics.find((diagnostic) => diagnostic.name === "project_layout");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("project checks skipped");
    expect(report.ok).toBe(true);
  });

  it("warns on a missing cache but fails on a corrupt one", () => {
    const missing = evaluateDoctorDiagnostics({
      ...HEALTHY,
      project: { projectRoot: "/repo", cache: { status: "missing", detail: "no cache file" } },
    });
    const missingCheck = missing.diagnostics.find(
      (diagnostic) => diagnostic.name === "graph_cache",
    );
    expect(missingCheck?.status).toBe("warn");
    expect(missingCheck?.remedy).toContain("graph sync");
    expect(missing.ok).toBe(true);
    expect(missing.warnings).toBe(1);

    const corrupt = evaluateDoctorDiagnostics({
      ...HEALTHY,
      project: { projectRoot: "/repo", cache: { status: "corrupt", detail: "bad bytes" } },
    });
    const corruptCheck = corrupt.diagnostics.find(
      (diagnostic) => diagnostic.name === "graph_cache",
    );
    expect(corruptCheck?.status).toBe("fail");
    expect(corrupt.ok).toBe(false);
  });

  it("fails typed schema, pack and adapter problems with remedies", () => {
    const report = evaluateDoctorDiagnostics({
      ...HEALTHY,
      project: {
        projectRoot: "/repo",
        manifestError: "manifest digest mismatch",
        packLockError: "pack lockfile unreadable",
        schemaErrors: ["node x fails schema"],
        adapterErrors: ["adapter y failed to load"],
        cache: { status: "ok" },
      },
    });
    const byName = new Map(report.diagnostics.map((diagnostic) => [diagnostic.name, diagnostic]));
    expect(byName.get("project_layout")?.status).toBe("fail");
    expect(byName.get("pack_lock")?.status).toBe("fail");
    expect(byName.get("schema_validation")?.category).toBe("schema");
    expect(byName.get("adapter_loading")?.category).toBe("adapter");
    for (const diagnostic of report.diagnostics) {
      if (diagnostic.status !== "pass") expect(diagnostic.remedy).toBeDefined();
    }
    expect(report.failed).toBe(4);
  });
});

describe("collectDoctorProbes", () => {
  it("collects environment probes without a project outside a managed root", () => {
    const probes = collectDoctorProbes(makeTempDir(), {
      gitVersion: () => "git version 2.50.0",
      nodeVersion: "v22.13.0",
    });
    expect(probes.nodeVersion).toBe("v22.13.0");
    expect(probes.gitVersion).toBe("git version 2.50.0");
    expect(probes.project).toBeUndefined();
  });
});
