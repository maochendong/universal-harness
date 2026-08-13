import { describe, expect, it } from "vitest";

import { allocateTierBudgets } from "../../src/context/budget.js";

import { mulberry32, randomInt } from "./seeds.js";

describe("tier budget allocation properties", () => {
  it("always covers all five tiers, stays non-negative and sums to the total", () => {
    const random = mulberry32(1401);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const total = randomInt(random, 1_000_000);
      const allocation = allocateTierBudgets(total);
      expect(allocation.map((entry) => entry.tier)).toEqual([1, 2, 3, 4, 5]);
      expect(allocation.every((entry) => entry.tokens >= 0)).toBe(true);
      expect(allocation.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(total);
    }
  });

  it("is deterministic for any budget", () => {
    const random = mulberry32(1402);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const total = randomInt(random, 1_000_000);
      expect(allocateTierBudgets(total)).toEqual(allocateTierBudgets(total));
    }
  });

  it("never lets a lower-priority tier outrank a higher one beyond one token", () => {
    const random = mulberry32(1403);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const total = randomInt(random, 10_000);
      const byTier = new Map(allocateTierBudgets(total).map((entry) => [entry.tier, entry.tokens]));
      for (let tier = 1; tier < 5; tier += 1) {
        const higher = byTier.get(tier) ?? 0;
        const lower = byTier.get(tier + 1) ?? 0;
        // Shares decrease with tier; rounding may add at most one token.
        expect(lower).toBeLessThanOrEqual(higher + 1);
      }
    }
  });
});
