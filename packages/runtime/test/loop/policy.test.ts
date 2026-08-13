import { describe, expect, it } from "vitest";

import {
  GENERIC_PACK_LOOP_DEFAULTS,
  isLoopPolicy,
  resolveLoopPolicy,
  LoopError,
} from "../../src/loop/policy.js";
import { PolicyError } from "../../src/policy/action.js";

import { POLICY_FIELD as field, effectiveWith } from "./fixtures.js";

describe("resolveLoopPolicy", () => {
  it("falls back to the generic pack defaults and is deterministic", () => {
    const policy = resolveLoopPolicy(effectiveWith([]));
    expect(policy.max_steps).toBe(GENERIC_PACK_LOOP_DEFAULTS.max_steps);
    expect(policy.max_tokens).toBe(GENERIC_PACK_LOOP_DEFAULTS.max_tokens);
    expect(policy.max_duration_ms).toBe(GENERIC_PACK_LOOP_DEFAULTS.max_duration_ms);
    expect(policy.max_tool_retries).toBe(GENERIC_PACK_LOOP_DEFAULTS.max_tool_retries);
    expect(policy.repeat_detection).toEqual({ window: 6, identical_action_limit: 2 });
    expect(policy.termination).toEqual({
      require_structured_signal: true,
      require_external_verification: true,
      budget_ceiling: "hard",
    });
    expect(policy.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolveLoopPolicy(effectiveWith([]))).toEqual(policy);
    expect(isLoopPolicy(policy)).toBe(true);
  });

  it("reads declared loop.* fields from the effective policy", () => {
    const effective = effectiveWith([
      field("loop.max_steps", "hard_ceiling", 12),
      field("loop.max_tokens", "hard_ceiling", 5000),
      field("loop.repeat_detection.window", "hard_ceiling", 4),
      field("loop.repeat_detection.identical_action_limit", "hard_ceiling", 3),
      field("loop.termination.require_external_verification", "project_default", false),
    ]);
    const policy = resolveLoopPolicy(effective);
    expect(policy.max_steps).toBe(12);
    expect(policy.max_tokens).toBe(5000);
    expect(policy.repeat_detection).toEqual({ window: 4, identical_action_limit: 3 });
    expect(policy.termination.require_external_verification).toBe(false);
    expect(policy.effective_policy_digest).toBe(effective.digest);
  });

  it("lowers ceilings without authorization", () => {
    const policy = resolveLoopPolicy(effectiveWith([]), {
      overrides: { max_steps: 5, max_tokens: 100, max_duration_ms: 1000, max_tool_retries: 0 },
    });
    expect(policy.max_steps).toBe(5);
    expect(policy.max_tokens).toBe(100);
    expect(policy.max_tool_retries).toBe(0);
  });

  it("rejects raising a ceiling without a policy authorization", () => {
    expect(() =>
      resolveLoopPolicy(effectiveWith([field("loop.max_steps", "hard_ceiling", 10)]), {
        overrides: { max_steps: 11 },
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      resolveLoopPolicy(effectiveWith([field("loop.max_steps", "hard_ceiling", 10)]), {
        overrides: { max_steps: 11 },
      }),
    ).toThrowError(/requires a policy authorization/u);
  });

  it("allows an authorized raise but clamps it to the installation-level maximum", () => {
    const effective = effectiveWith([
      field("loop.max_steps", "hard_ceiling", 10),
      field("loop.ceiling.max_steps", "hard_ceiling", 14),
    ]);
    const policy = resolveLoopPolicy(effective, {
      overrides: { max_steps: 50 },
      authorization_digest: "e".repeat(64),
    });
    expect(policy.max_steps).toBe(14);
    const raised = resolveLoopPolicy(effective, {
      overrides: { max_steps: 12 },
      authorization_digest: "e".repeat(64),
    });
    expect(raised.max_steps).toBe(12);
  });

  it("has no override channel that weakens or disables repeat detection", () => {
    const effective = effectiveWith([
      field("loop.repeat_detection.window", "hard_ceiling", 8),
      field("loop.repeat_detection.identical_action_limit", "hard_ceiling", 4),
    ]);
    // Even a smuggled override key is ignored: detection stays exactly as the
    // policy declares it.
    const policy = resolveLoopPolicy(effective, {
      overrides: { repeat_detection: { window: 0, identical_action_limit: 999 } },
    } as never);
    expect(policy.repeat_detection).toEqual({ window: 8, identical_action_limit: 4 });
  });

  it("requires authorization to relax termination rules but not to tighten them", () => {
    const relaxed = (): unknown =>
      resolveLoopPolicy(effectiveWith([]), {
        overrides: { termination: { require_external_verification: false } },
      });
    expect(relaxed).toThrowError(PolicyError);
    const authorized = resolveLoopPolicy(effectiveWith([]), {
      overrides: { termination: { require_external_verification: false, budget_ceiling: "soft" } },
      authorization_digest: "e".repeat(64),
    });
    expect(authorized.termination.require_external_verification).toBe(false);
    expect(authorized.termination.budget_ceiling).toBe("soft");
  });

  it("rejects invalid declared values with a typed loop error", () => {
    expect(() =>
      resolveLoopPolicy(effectiveWith([field("loop.repeat_detection.window", "hard_ceiling", 0)])),
    ).toThrowError(LoopError);
    expect(() =>
      resolveLoopPolicy(effectiveWith([]), { overrides: { max_steps: -1 } }),
    ).toThrowError(LoopError);
  });
});
