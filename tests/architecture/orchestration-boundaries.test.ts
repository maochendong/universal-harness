import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * T8-A authority boundaries (slim-profiles design 9.5): the DAG engine
 * understands only DAG nodes, checkpoints, typed results and invalidation —
 * never profile names — and the Kernel Coordinator reaches module behavior
 * only through registered contributions, so an unenabled module can be
 * deleted without affecting the Kernel happy path.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

const ENGINE_SOURCES = [
  "packages/runtime/src/workflow/dag.ts",
  "packages/runtime/src/workflow/dag-engine.ts",
];

const PROFILE_IDENTIFIERS = /"(?:lite|standard|governed)"|profile_id|profileId|ProfileId/u;

describe("orchestration module boundaries", () => {
  it("keeps the DAG engine free of profile names and profile branching", () => {
    for (const source of ENGINE_SOURCES) {
      expect(PROFILE_IDENTIFIERS.test(read(source)), source).toBe(false);
    }
  });

  it("keeps the Kernel Coordinator free of profile names", () => {
    expect(
      PROFILE_IDENTIFIERS.test(read("packages/runtime/src/orchestration/kernel-coordinator.ts")),
    ).toBe(false);
  });

  it("keeps the Kernel Coordinator independent of module contributors", () => {
    const coordinator = read("packages/runtime/src/orchestration/kernel-coordinator.ts");
    const types = read("packages/runtime/src/orchestration/pipeline-types.ts");
    for (const source of [coordinator, types]) {
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      expect(
        imports.filter((specifier) => specifier.includes("contributors")),
        JSON.stringify(imports),
      ).toEqual([]);
    }
  });

  it("keeps contributors one-directional: no imports from the facade", () => {
    const contributors = [
      "packages/runtime/src/orchestration/contributors/impact-contributor.ts",
      "packages/runtime/src/orchestration/contributors/evaluation-contributor.ts",
      "packages/runtime/src/orchestration/contributors/audit-contributor.ts",
    ];
    for (const contributor of contributors) {
      const imports = [...read(contributor).matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      expect(
        imports.filter((specifier) => specifier.includes("orchestrator")),
        contributor,
      ).toEqual([]);
    }
  });

  it("keeps the facade as the only composition root wiring contributors", () => {
    const facade = read("packages/runtime/src/orchestration/orchestrator.ts");
    for (const factory of [
      "createImpactContribution",
      "createEvaluationContribution",
      "createAuditContribution",
    ]) {
      expect(facade, factory).toContain(factory);
    }
    // The coordinator must stay profile-agnostic and module-agnostic: it
    // references the built-in contributor factories nowhere.
    const coordinator = read("packages/runtime/src/orchestration/kernel-coordinator.ts");
    for (const factory of [
      "createImpactContribution",
      "createEvaluationContribution",
      "createAuditContribution",
    ]) {
      expect(coordinator, factory).not.toContain(factory);
    }
  });
});
