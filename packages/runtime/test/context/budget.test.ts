import { describe, expect, it } from "vitest";

import { allocateTierBudgets, estimateTokens } from "../../src/context/budget.js";
import { ContextError } from "../../src/context/selector.js";

describe("estimateTokens", () => {
  it("estimates four characters per token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(41))).toBe(11);
  });
});

describe("allocateTierBudgets", () => {
  it("splits a round budget by the fixed tier weights", () => {
    expect(allocateTierBudgets(100)).toEqual([
      { tier: 1, tokens: 30 },
      { tier: 2, tokens: 25 },
      { tier: 3, tokens: 20 },
      { tier: 4, tokens: 15 },
      { tier: 5, tokens: 10 },
    ]);
  });

  it("distributes rounding leftovers by largest remainder, ties by tier order", () => {
    const allocation = allocateTierBudgets(7);
    expect(allocation.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(7);
    expect(allocation).toEqual([
      { tier: 1, tokens: 2 },
      { tier: 2, tokens: 2 },
      { tier: 3, tokens: 1 },
      { tier: 4, tokens: 1 },
      { tier: 5, tokens: 1 },
    ]);
  });

  it("allocates a zero budget as zero everywhere", () => {
    expect(allocateTierBudgets(0).every((entry) => entry.tokens === 0)).toBe(true);
  });

  it("rejects negative or fractional budgets", () => {
    for (const budget of [-1, 1.5, Number.NaN]) {
      expect(() => allocateTierBudgets(budget)).toThrowError(ContextError);
      expect(() => allocateTierBudgets(budget)).toThrowError(/non-negative integer/);
    }
  });
});
