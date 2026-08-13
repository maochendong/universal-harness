import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PackError,
  commitTransactionalWrites,
  comparePackVersions,
  planPackMigration,
  runPackMigration,
  type PackMigrationRegistry,
  type PackMigrationStep,
} from "../../src/index.js";
import { field } from "../policy/fixtures.js";
import { PACK_NAME, cleanupTempProjects, makeTempProject } from "./fixtures.js";

afterEach(cleanupTempProjects);

const RENAME_STEPS: PackMigrationRegistry = {
  [PACK_NAME]: [
    {
      from_version: "1.0.0",
      to_version: "1.1.0",
      description: "rename loop.max_steps to loop.step_ceiling",
      migrate: (fields) =>
        fields.map((entry) =>
          entry.path === "loop.max_steps" ? { ...entry, path: "loop.step_ceiling" } : entry,
        ),
    },
    {
      from_version: "1.1.0",
      to_version: "2.0.0",
      description: "tighten the step ceiling to an integer bound",
      migrate: (fields) => fields,
    },
  ],
};

describe("planPackMigration", () => {
  it("plans an exact multi-hop chain", () => {
    const chain = planPackMigration(RENAME_STEPS, PACK_NAME, "1.0.0", "2.0.0");
    expect(chain.map((step) => step.to_version)).toEqual(["1.1.0", "2.0.0"]);
  });

  it("needs no migration for equal versions", () => {
    expect(planPackMigration(RENAME_STEPS, PACK_NAME, "1.0.0", "1.0.0")).toEqual([]);
  });

  it("fails with a typed error when the chain has a gap", () => {
    try {
      planPackMigration(RENAME_STEPS, PACK_NAME, "1.0.0", "3.0.0");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackError);
      expect((error as PackError).kind).toBe("migration_unavailable");
    }
  });

  it("refuses a cycling migration chain", () => {
    const cyclic: PackMigrationRegistry = {
      [PACK_NAME]: [
        {
          from_version: "1.0.0",
          to_version: "1.1.0",
          description: "forward",
          migrate: (fields) => fields,
        },
        {
          from_version: "1.1.0",
          to_version: "1.0.0",
          description: "back",
          migrate: (fields) => fields,
        },
      ],
    };
    expect(() => planPackMigration(cyclic, PACK_NAME, "1.0.0", "9.9.9")).toThrowError(PackError);
  });
});

describe("runPackMigration", () => {
  it("applies every step in order and records the applied chain", () => {
    const outcome = runPackMigration(planPackMigration(RENAME_STEPS, PACK_NAME, "1.0.0", "2.0.0"), [
      field("loop.max_steps", "hard_ceiling", 20),
      field("paths.deny", "deny_union", [".git"]),
    ]);
    expect(outcome.fields.map((entry) => entry.path)).toEqual(["loop.step_ceiling", "paths.deny"]);
    expect(outcome.applied).toHaveLength(2);
  });

  it("wraps a throwing step as a typed migration failure", () => {
    const failing: PackMigrationStep = {
      from_version: "1.0.0",
      to_version: "2.0.0",
      description: "boom",
      migrate: () => {
        throw new Error("corrupt override state");
      },
    };
    try {
      runPackMigration([failing], [field("loop.max_steps", "hard_ceiling", 20)]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackError);
      expect((error as PackError).kind).toBe("migration_failed");
    }
  });

  it("rejects a step that produces duplicate or invalid fields", () => {
    const duplicating: PackMigrationStep = {
      from_version: "1.0.0",
      to_version: "2.0.0",
      description: "collapse two fields onto one path",
      migrate: (fields) => fields.map((entry) => ({ ...entry, path: "loop.max_steps" })),
    };
    expect(() =>
      runPackMigration(
        [duplicating],
        [field("loop.max_steps", "hard_ceiling", 20), field("loop.max_tokens", "hard_ceiling", 10)],
      ),
    ).toThrowError(PackError);
  });
});

describe("commitTransactionalWrites", () => {
  it("commits every file when all writes succeed", () => {
    const { projectRoot } = makeTempProject();
    const first = join(projectRoot, ".harness", "a.json");
    const second = join(projectRoot, ".harness", "nested", "b.json");
    commitTransactionalWrites([
      { path: first, content: "{}\n" },
      { path: second, content: "[]\n" },
    ]);
    expect(readFileSync(first, "utf8")).toBe("{}\n");
    expect(readFileSync(second, "utf8")).toBe("[]\n");
  });

  it("rolls every earlier write back when a later write fails", () => {
    const { projectRoot } = makeTempProject();
    const first = join(projectRoot, ".harness", "a.json");
    writeFileSync(first, "original\n", "utf8");
    const blocker = join(projectRoot, ".harness", "blocker");
    writeFileSync(blocker, "a file, not a directory\n", "utf8");
    expect(() =>
      commitTransactionalWrites([
        { path: first, content: "updated\n" },
        { path: join(blocker, "b.json"), content: "{}\n" },
      ]),
    ).toThrow();
    expect(readFileSync(first, "utf8")).toBe("original\n");
    expect(existsSync(join(blocker, "b.json"))).toBe(false);
  });

  it("removes files a rolled-back transaction created", () => {
    const { projectRoot } = makeTempProject();
    const created = join(projectRoot, ".harness", "new.json");
    const blocker = join(projectRoot, ".harness", "blocker");
    writeFileSync(blocker, "a file, not a directory\n", "utf8");
    expect(() =>
      commitTransactionalWrites([
        { path: created, content: "{}\n" },
        { path: join(blocker, "b.json"), content: "{}\n" },
      ]),
    ).toThrow();
    expect(existsSync(created)).toBe(false);
  });
});

describe("comparePackVersions", () => {
  it("orders semantic versions numerically", () => {
    expect(comparePackVersions("1.0.0", "1.0.0")).toBe(0);
    expect(comparePackVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(comparePackVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });
});
