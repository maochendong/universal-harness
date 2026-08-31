import { describe, expect, it } from "vitest";

import {
  ESCALATION_ACTION_KINDS,
  POLICY_ACTION_KINDS,
  SCHEDULER_POLICY_ACTION_KINDS,
  PolicyError,
  actionDigest,
  normalizeAction,
  riskRank,
} from "../../src/policy/action.js";

describe("normalizeAction", () => {
  it("normalizes a complete valid action", () => {
    const action = normalizeAction({
      kind: "invoke_tool",
      actor: "adapter_01",
      actor_kind: "adapter",
      origin: "prompt",
      phase: "implementation",
      resource: "apply_patch",
      parameters: { path: "src/index.ts", options: { dry_run: false, budget: [1, 2] } },
      risk: "medium",
      approval_digest: "a".repeat(64),
      control_profile: {
        control: "managed",
        trajectory_visibility: "full",
        usage_metering: true,
        side_effect_interception: true,
      },
    });
    expect(action.kind).toBe("invoke_tool");
    expect(action.parameters).toEqual({
      path: "src/index.ts",
      options: { dry_run: false, budget: [1, 2] },
    });
  });

  it("defaults parameters to an empty object", () => {
    const action = normalizeAction({
      kind: "read_path",
      actor: "adapter_01",
      actor_kind: "adapter",
      origin: "prompt",
      phase: "implementation",
      risk: "low",
    });
    expect(action.parameters).toEqual({});
    expect(action.resource).toBeUndefined();
    expect(action.approval_digest).toBeUndefined();
    expect(action.control_profile).toBeUndefined();
  });

  it("produces a digest that ignores parameter key order", () => {
    const base = {
      kind: "invoke_tool",
      actor: "adapter_01",
      actor_kind: "adapter",
      origin: "prompt",
      phase: "implementation",
      resource: "apply_patch",
      risk: "low",
    } as const;
    const first = normalizeAction({ ...base, parameters: { a: 1, b: { c: 2, d: 3 } } });
    const second = normalizeAction({ ...base, parameters: { b: { d: 3, c: 2 }, a: 1 } });
    expect(actionDigest(first)).toBe(actionDigest(second));
    expect(actionDigest(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unknown kinds, risks, origins and actor kinds", () => {
    const base = {
      kind: "read_path",
      actor: "adapter_01",
      actor_kind: "adapter",
      origin: "prompt",
      phase: "implementation",
      risk: "low",
    };
    expect(() => normalizeAction({ ...base, kind: "delete_everything" })).toThrowError(PolicyError);
    expect(() => normalizeAction({ ...base, risk: "extreme" })).toThrowError(PolicyError);
    expect(() => normalizeAction({ ...base, origin: "model" })).toThrowError(PolicyError);
    expect(() => normalizeAction({ ...base, actor_kind: "provider" })).toThrowError(PolicyError);
    expect(() => normalizeAction({ ...base, actor: " " })).toThrowError(PolicyError);
    expect(() => normalizeAction("read src")).toThrowError(PolicyError);
  });

  it("rejects parameters that are not plain JSON", () => {
    const base = {
      kind: "invoke_tool",
      actor: "adapter_01",
      actor_kind: "adapter",
      origin: "prompt",
      phase: "implementation",
      risk: "low",
    };
    expect(() => normalizeAction({ ...base, parameters: { limit: Number.NaN } })).toThrowError(
      PolicyError,
    );
    expect(() => normalizeAction({ ...base, parameters: { callback: () => 1 } })).toThrowError(
      PolicyError,
    );
    expect(() => normalizeAction({ ...base, parameters: { date: new Date(0) } })).toThrowError(
      PolicyError,
    );
    expect(() => normalizeAction({ ...base, parameters: { missing: undefined } })).toThrowError(
      PolicyError,
    );
  });

  it("rejects an invalid adapter control profile", () => {
    const base = {
      kind: "invoke_tool",
      actor: "adapter_01",
      actor_kind: "adapter",
      origin: "prompt",
      phase: "implementation",
      risk: "low",
    };
    expect(() =>
      normalizeAction({
        ...base,
        control_profile: { control: "absolute", trajectory_visibility: "full" },
      }),
    ).toThrowError(PolicyError);
  });

  it("keeps escalation kinds inside the action kind set", () => {
    for (const kind of ESCALATION_ACTION_KINDS) {
      expect(POLICY_ACTION_KINDS).toContain(kind);
    }
  });

  it("appends the protocol 1.3 scheduler kinds without disturbing the legacy set", () => {
    for (const kind of SCHEDULER_POLICY_ACTION_KINDS) {
      expect(POLICY_ACTION_KINDS).toContain(kind);
    }
    // Scheduler actions are control-plane decisions, not escalation: they are
    // never part of ESCALATION_ACTION_KINDS, but a prompt origin still cannot
    // lend them approval authority (covered by the evaluator tests).
    for (const kind of SCHEDULER_POLICY_ACTION_KINDS) {
      expect(ESCALATION_ACTION_KINDS).not.toContain(kind);
    }
  });

  it("ranks risks in ascending order", () => {
    expect(riskRank("low")).toBeLessThan(riskRank("medium"));
    expect(riskRank("medium")).toBeLessThan(riskRank("high"));
    expect(riskRank("high")).toBeLessThan(riskRank("critical"));
  });
});
