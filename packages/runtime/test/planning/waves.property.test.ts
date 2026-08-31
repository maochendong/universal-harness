import { canonicalizeJson } from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import type { Protocol13TaskSpecification } from "../../src/planning/task.js";
import {
  compileParallelWaves,
  writePathsOverlap,
  type ParallelWave,
} from "../../src/planning/waves.js";
import { mulberry32, randomInt } from "../context/seeds.js";

/**
 * Wave compiler properties (M4 design 6.2/25, plan Task 3 step 3): over at
 * least 1,000 seeded DAGs, identical canonical input compiles byte-identical,
 * every dependency lands in an earlier actual wave, no write/write or
 * exclusive-resource conflict shares a wave, every Task appears exactly once
 * and Plan declaration order stays the only tie-break — an input permutation
 * never becomes an implicit second ordering.
 */
const PATH_POOL = [
  "src/api",
  "src/api/routes",
  "src/api/routes/health",
  "src/ui",
  "src/ui/components",
  "packages/core",
  "packages/runtime",
  "docs",
] as const;

const RESOURCE_POOL = [
  "database-schema",
  "generated-client",
  "service-port:8080",
  "message-queue",
] as const;

function generateDag(random: () => number): Protocol13TaskSpecification[] {
  const count = randomInt(random, 24) + 2;
  // A random rank permutation keeps the graph acyclic while declaration
  // order is independent of topological order.
  const ranks = Array.from({ length: count }, (_, index) => index);
  for (let index = ranks.length - 1; index > 0; index -= 1) {
    const swap = randomInt(random, index + 1);
    [ranks[index], ranks[swap]] = [ranks[swap] as number, ranks[index] as number];
  }
  const ids = Array.from({ length: count }, (_, index) => `task_${String(index).padStart(3, "0")}`);
  return ids.map((id, index) => {
    const rank = ranks[index] as number;
    const dependencyCount = randomInt(random, Math.min(3, rank) + 1);
    const dependencyIndexes = new Set<number>();
    while (dependencyIndexes.size < dependencyCount) {
      const candidate = randomInt(random, count);
      if ((ranks[candidate] as number) < rank) dependencyIndexes.add(candidate);
    }
    const writePaths = new Set<string>();
    const writePathCount = randomInt(random, 3);
    while (writePaths.size < writePathCount) {
      writePaths.add(PATH_POOL[randomInt(random, PATH_POOL.length)] as string);
    }
    const resources = new Set<string>();
    if (random() < 0.5) {
      resources.add(RESOURCE_POOL[randomInt(random, RESOURCE_POOL.length)] as string);
    }
    return {
      id,
      objective: `deliver ${id}`,
      impact_paths: [["edge-1"]],
      expected_outputs: [`code_${id}`],
      capabilities: [],
      tools: [],
      dependencies: [...dependencyIndexes].map((dep) => ids[dep] as string),
      risk: "low",
      budget: { steps: 4, tokens: 1_000, duration_ms: 60_000 },
      write_paths: [...writePaths],
      exclusive_resources: [...resources],
      acceptance: [{ description: "the output verifies", verification: "gate:test" }],
      required_gates: ["gate:test"],
    };
  });
}

function waveOfTask(waves: readonly ParallelWave[]): Map<string, number> {
  const placement = new Map<string, number>();
  for (const wave of waves) {
    for (const id of wave.task_ids) placement.set(id, wave.wave_index);
  }
  return placement;
}

function expectWaveInvariants(
  tasks: readonly Protocol13TaskSpecification[],
  waves: readonly ParallelWave[],
): void {
  const placement = waveOfTask(waves);
  // Every Task appears exactly once and wave indexes are dense from zero.
  expect(waves.flatMap((wave) => wave.task_ids).length).toBe(tasks.length);
  expect(placement.size).toBe(tasks.length);
  waves.forEach((wave, index) => expect(wave.wave_index).toBe(index));
  // Every dependency lands in a strictly earlier actual wave.
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      expect(placement.get(dependency)).toBeLessThan(placement.get(task.id) as number);
    }
  }
  // No write/write or exclusive-resource conflict shares a wave.
  for (const wave of waves) {
    for (let left = 0; left < wave.task_ids.length; left += 1) {
      for (let right = left + 1; right < wave.task_ids.length; right += 1) {
        const first = tasks.find((task) => task.id === wave.task_ids[left]);
        const second = tasks.find((task) => task.id === wave.task_ids[right]);
        if (first === undefined || second === undefined) {
          throw new Error("wave references an unknown task");
        }
        for (const firstPath of first.write_paths) {
          for (const secondPath of second.write_paths) {
            expect(writePathsOverlap(firstPath, secondPath)).toBe(false);
          }
        }
        for (const resource of first.exclusive_resources) {
          expect(second.exclusive_resources).not.toContain(resource);
        }
      }
    }
  }
}

describe("compileParallelWaves properties", () => {
  it("holds invariants over 1,000 seeded DAGs", () => {
    const random = mulberry32(2026_08_31);
    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const tasks = generateDag(random);
      const first = compileParallelWaves(tasks);
      // Identical canonical input compiles byte-identical waves.
      const second = compileParallelWaves(tasks);
      expect(canonicalizeJson(second)).toBe(canonicalizeJson(first));
      expectWaveInvariants(tasks, first);

      // A permutation of the declaration order must not be silently sorted
      // back. Independent, conflict-free tasks all land in wave 0 in exact
      // declaration order — both for the original and for a shuffled input —
      // proving declaration order is the only tie-break and never becomes an
      // implicit second ordering.
      const independent = tasks.map((task, index) => ({
        ...task,
        dependencies: [],
        write_paths: [`src/unique-${String(index)}`],
        exclusive_resources: [],
      }));
      const independentWaves = compileParallelWaves(independent);
      expect(independentWaves).toHaveLength(1);
      expect(independentWaves[0]?.task_ids).toEqual(independent.map((task) => task.id));
      const shuffled = [...independent];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = randomInt(random, index + 1);
        [shuffled[index], shuffled[swap]] = [
          shuffled[swap] as Protocol13TaskSpecification,
          shuffled[index] as Protocol13TaskSpecification,
        ];
      }
      const shuffledWaves = compileParallelWaves(shuffled);
      expect(shuffledWaves).toHaveLength(1);
      expect(shuffledWaves[0]?.task_ids).toEqual(shuffled.map((task) => task.id));

      // The full DAG invariants also hold for a permuted declaration order.
      const permuted = [...tasks];
      for (let index = permuted.length - 1; index > 0; index -= 1) {
        const swap = randomInt(random, index + 1);
        [permuted[index], permuted[swap]] = [
          permuted[swap] as Protocol13TaskSpecification,
          permuted[index] as Protocol13TaskSpecification,
        ];
      }
      expectWaveInvariants(permuted, compileParallelWaves(permuted));
    }
  });
});
