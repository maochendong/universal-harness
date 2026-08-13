import { ContextError, type SourceTier } from "./selector.js";

/**
 * Token accounting for context assembly (design 13.4). M1 uses one fixed,
 * deterministic estimate — four characters per token — so budgets,
 * allocation and compression decisions reproduce exactly on recompile.
 * Callers with provider-specific tokenizers plug them in through a custom
 * compressor; the budget split itself stays deterministic.
 */
export function estimateTokens(content: string): number {
  if (content.length === 0) return 0;
  return Math.ceil(content.length / 4);
}

export interface TierAllocation {
  readonly tier: SourceTier;
  readonly tokens: number;
}

/** Fixed per-tier budget shares (percent), applied to the task budget. */
export const TIER_WEIGHTS: readonly { readonly tier: SourceTier; readonly weight: number }[] = [
  { tier: 1, weight: 30 },
  { tier: 2, weight: 25 },
  { tier: 3, weight: 20 },
  { tier: 4, weight: 15 },
  { tier: 5, weight: 10 },
];

/**
 * Split a total token budget across the five source tiers with
 * largest-remainder rounding: every tier gets the floor of its share and the
 * leftover tokens go to the largest fractional remainders, ties broken by
 * tier order. The allocation is deterministic and always sums exactly to
 * the requested total.
 */
export function allocateTierBudgets(totalTokens: number): readonly TierAllocation[] {
  if (!Number.isInteger(totalTokens) || totalTokens < 0) {
    throw new ContextError(
      "invalid_budget",
      `token budget must be a non-negative integer, got ${String(totalTokens)}`,
    );
  }
  const shares = TIER_WEIGHTS.map(({ tier, weight }) => {
    const exact = (totalTokens * weight) / 100;
    const floored = Math.floor(exact);
    return { tier, floored, remainder: exact - floored };
  });
  let leftover = totalTokens - shares.reduce((sum, share) => sum + share.floored, 0);
  const ranked = [...shares].sort(
    (left, right) => right.remainder - left.remainder || left.tier - right.tier,
  );
  const granted = new Map<SourceTier, number>(shares.map((share) => [share.tier, share.floored]));
  for (const share of ranked) {
    if (leftover <= 0) break;
    granted.set(share.tier, (granted.get(share.tier) ?? 0) + 1);
    leftover -= 1;
  }
  return TIER_WEIGHTS.map(({ tier }) => ({ tier, tokens: granted.get(tier) ?? 0 }));
}
