import { describe, expect, it } from "vitest";

import { sha256Hex, validateSchema, type NodeRecord } from "@universal-harness-internal/core";

import {
  compileContextBundle,
  type CompileContextInput,
  type ContextCandidate,
} from "../../src/context/compiler.js";
import { stalenessReasons } from "../../src/context/freshness.js";
import type { SourceTier } from "../../src/context/selector.js";

import { BINDINGS, makeNode } from "./fixtures.js";
import { mulberry32, pick, randomInt } from "./seeds.js";

const WORDS = ["alpha", "beta", "gamma", "delta", "router", "health", "gate", "policy"];
const TYPES: readonly NodeRecord["type"][] = [
  "Requirement",
  "Constraint",
  "Decision",
  "Component",
  "CodeArtifact",
  "Test",
  "Finding",
  "Gate",
];

function randomContent(random: () => number): string {
  const lines = Array.from({ length: randomInt(random, 9) }, () =>
    Array.from({ length: randomInt(random, 6) + 1 }, () => pick(random, WORDS)).join(" "),
  );
  return lines.join("\n");
}

function randomInput(random: () => number): CompileContextInput {
  const count = randomInt(random, 10) + 1;
  const candidates: ContextCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    // The first candidate always fits: tier 1 gets at least one token of any
    // positive budget, so at least one source survives every draw.
    const content = index === 0 ? "goal" : randomContent(random);
    const tier: SourceTier = index === 0 ? 1 : ((randomInt(random, 5) + 1) as SourceTier);
    const lines = content.split("\n").filter((line) => line.length > 0);
    const withProtected = index !== 0 && lines.length > 0 && random() < 0.4;
    const base: ContextCandidate = {
      node: makeNode(`node_${String(index).padStart(2, "0")}`, pick(random, TYPES)),
      content,
      tier,
      reason: `candidate ${index}`,
    };
    candidates.push({
      ...base,
      ...(withProtected ? { protectedFields: [pick(random, lines)] } : {}),
      ...(random() < 0.3 ? { sensitive: true } : {}),
    });
  }
  // Caller exclusions never touch the first candidate, so at least one
  // source always survives.
  const exclusions = candidates
    .slice(1)
    .filter(() => random() < 0.2)
    .map((item) => ({ nodeId: item.node.id, reason: "property_exclusion" }));
  return {
    taskId: "task_prop",
    goal: "property goal",
    bindings: BINDINGS,
    tokenBudget: randomInt(random, 2000) + 1,
    candidates,
    exclusions,
  };
}

describe("context compilation properties", () => {
  it("compiles random source sets into valid, reproducible, traceable bundles", () => {
    const random = mulberry32(1414);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const spec = randomInput(random);
      const compiled = compileContextBundle(spec);
      const { manifest, record, assembled } = compiled;

      // Valid schema, reproducible output.
      expect(validateSchema("runtime", record).valid).toBe(true);
      const recompiled = compileContextBundle(spec);
      expect(recompiled.manifest).toEqual(manifest);
      expect(recompiled.record).toEqual(record);
      expect(recompiled.assembled).toBe(assembled);

      // Every candidate is accounted for exactly once; caller exclusions win.
      const excludedByCaller = new Set((spec.exclusions ?? []).map((item) => item.nodeId));
      const accounted = new Set<string>();
      for (const entry of manifest.entries) accounted.add(entry.node_id);
      for (const exclusion of manifest.exclusions) {
        expect(exclusion.reason.length).toBeGreaterThan(0);
        expect(accounted.has(exclusion.node_id)).toBe(false);
        accounted.add(exclusion.node_id);
      }
      for (const item of spec.candidates) expect(accounted.has(item.node.id)).toBe(true);
      for (const entry of manifest.entries) {
        expect(excludedByCaller.has(entry.node_id)).toBe(false);
      }

      // Entries stay in priority order and exclusions are reproducible.
      const priorities = manifest.entries.map((entry) => `${entry.priority}:${entry.node_id}`);
      expect([...priorities].sort()).toEqual(priorities);

      // Protected fields of included sources survive compression.
      const byId = new Map(spec.candidates.map((item) => [item.node.id, item]));
      for (const entry of manifest.entries) {
        for (const field of byId.get(entry.node_id)?.protectedFields ?? []) {
          expect(assembled).toContain(field);
        }
      }

      // Without protected content the bundle never exceeds the task budget.
      const anyProtected = spec.candidates.some(
        (item) => (item.protectedFields ?? []).length > 0 && !excludedByCaller.has(item.node.id),
      );
      if (!anyProtected) {
        expect(manifest.included_tokens).toBeLessThanOrEqual(spec.tokenBudget);
      }

      // A bundle compiled from current state is fresh.
      const currentDigests = new Map(
        spec.candidates.map((item) => [item.node.id, sha256Hex(item.content)]),
      );
      expect(
        stalenessReasons(manifest, { sourceDigests: currentDigests, bindings: BINDINGS }),
      ).toEqual([]);
    }
  });

  it("marks the bundle stale whenever any random source drifts", () => {
    const random = mulberry32(1415);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const spec = randomInput(random);
      const { manifest } = compileContextBundle(spec);
      const entries = manifest.entries;
      const target = entries[randomInt(random, entries.length)];
      if (target === undefined) continue;
      const currentDigests = new Map(
        spec.candidates.map((item) => [item.node.id, sha256Hex(item.content)]),
      );
      currentDigests.set(target.node_id, sha256Hex(`drifted ${String(iteration)}`));
      expect(
        stalenessReasons(manifest, { sourceDigests: currentDigests, bindings: BINDINGS }),
      ).toEqual([`source ${target.node_id} digest changed`]);
    }
  });
});
