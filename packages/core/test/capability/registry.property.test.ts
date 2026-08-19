import { describe, expect, it } from "vitest";

import {
  capabilityDependencyClosure,
  capabilityModuleDefinition,
} from "../../src/capability/registry.js";
import { CAPABILITY_IDS, type CapabilityId } from "../../src/schema/profile.js";
import { mulberry32, pick, randomInt } from "../identity/seeds.js";

function randomSubset(random: () => number): CapabilityId[] {
  const size = randomInt(random, CAPABILITY_IDS.length + 1);
  const chosen = new Set<CapabilityId>();
  while (chosen.size < size) {
    chosen.add(pick(random, CAPABILITY_IDS));
  }
  return [...chosen];
}

function shuffled<T>(random: () => number, values: readonly T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = randomInt(random, index + 1);
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return copy;
}

describe("capability dependency closure properties", () => {
  it("is a superset, idempotent, order-independent and dependency-complete", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = mulberry32(seed);
      const subset = randomSubset(random);
      const closure = capabilityDependencyClosure(subset);

      // Superset: every requested capability survives the closure.
      for (const capabilityId of subset) {
        expect(closure).toContain(capabilityId);
      }

      // Canonical: sorted and deduplicated regardless of input order.
      expect(closure).toEqual([...new Set(closure)].sort());
      expect(capabilityDependencyClosure(shuffled(random, subset))).toEqual(closure);

      // Idempotent: closing the closure changes nothing.
      expect(capabilityDependencyClosure(closure)).toEqual(closure);

      // Dependency-complete: every member's dependencies are members.
      for (const capabilityId of closure) {
        for (const dependency of capabilityModuleDefinition(capabilityId).depends_on) {
          expect(closure).toContain(dependency);
        }
      }

      // Strict TDD always drags design governance and impact analysis along.
      if (closure.includes("strict_tdd")) {
        expect(closure).toContain("design_governance");
        expect(closure).toContain("impact_analysis");
      }
    }
  });

  it("never invents capabilities outside the registry", () => {
    for (let seed = 1000; seed <= 1100; seed += 1) {
      const random = mulberry32(seed);
      const closure = capabilityDependencyClosure(randomSubset(random));
      for (const capabilityId of closure) {
        expect(CAPABILITY_IDS).toContain(capabilityId);
      }
    }
  });
});
