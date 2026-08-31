import { describe, expect, it } from "vitest";

import {
  POLICY_ACTION_KINDS,
  SCHEDULER_POLICY_ACTION_KINDS,
  PolicyError,
  actionDigest,
  normalizeAction,
} from "../../src/policy/action.js";
import {
  PROFILE_DEFAULT_MAX_CONCURRENCY,
  decideAction,
  mergePolicyLayers,
  resolveSchedulerCeilings,
} from "../../src/policy/evaluator.js";
import { action, field, layer } from "./fixtures.js";

const APPROVAL = "c".repeat(64);

function schedulerAction(kind: (typeof SCHEDULER_POLICY_ACTION_KINDS)[number]) {
  return action({
    kind,
    actor: "harness",
    actor_kind: "harness",
    origin: "control_plane",
    phase: "execute",
    resource: undefined,
    parameters: {
      operation_id: "operation_01",
      plan_digest: "b".repeat(64),
      baseline_commit: "0123456789abcdef0123456789abcdef01234567",
    },
    risk: "medium",
  });
}

describe("scheduler policy action vocabulary", () => {
  it("appends exactly the three Protocol 1.3 scheduler kinds", () => {
    expect(SCHEDULER_POLICY_ACTION_KINDS).toEqual([
      "dispatch_task",
      "retry_task",
      "integrate_wave",
    ]);
    // Appended, never reordered: the legacy ten kinds keep their positions.
    expect(POLICY_ACTION_KINDS.slice(0, -3)).toEqual([
      "read_path",
      "write_path",
      "invoke_tool",
      "propose_state",
      "submit_evidence",
      "approve",
      "accept_evidence",
      "change_policy",
      "register_tool",
      "grant_path",
    ]);
    expect(POLICY_ACTION_KINDS.slice(-3)).toEqual([...SCHEDULER_POLICY_ACTION_KINDS]);
  });

  it("normalizes every scheduler kind and keeps parameters digest-stable", () => {
    for (const kind of SCHEDULER_POLICY_ACTION_KINDS) {
      const normalized = normalizeAction({
        kind,
        actor: "harness",
        actor_kind: "harness",
        origin: "control_plane",
        phase: "execute",
        parameters: { wave_index: 0, task_ids: ["task_a", "task_b"] },
        risk: "medium",
      });
      expect(normalized.kind).toBe(kind);
      const reordered = normalizeAction({
        kind,
        actor: "harness",
        actor_kind: "harness",
        origin: "control_plane",
        phase: "execute",
        parameters: { task_ids: ["task_a", "task_b"], wave_index: 0 },
        risk: "medium",
      });
      expect(actionDigest(reordered)).toBe(actionDigest(normalized));
      expect(actionDigest(normalized)).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("keeps unknown values fail-closed as invalid_action", () => {
    for (const kind of ["dispatch_everything", "dispatch-task", "integrate"]) {
      try {
        normalizeAction({
          kind,
          actor: "harness",
          actor_kind: "harness",
          origin: "control_plane",
          phase: "execute",
          risk: "low",
        });
        expect.unreachable(`${kind} must be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(PolicyError);
        expect((error as PolicyError).kind).toBe("invalid_action");
      }
    }
  });
});

describe("scheduler action evaluation", () => {
  it("returns allow, deny, requires_approval and block for all three kinds", () => {
    for (const kind of SCHEDULER_POLICY_ACTION_KINDS) {
      const allowed = decideAction([], schedulerAction(kind));
      expect(allowed.outcome, kind).toBe("allow");

      const denied = decideAction(
        [layer("project", [field("phases.allow", "allow_intersection", ["plan"])])],
        schedulerAction(kind),
      );
      expect(denied.outcome, kind).toBe("deny");

      const needsApproval = decideAction(
        [layer("pack", [field("approvals.required", "approval_union", [kind])])],
        schedulerAction(kind),
      );
      expect(needsApproval.outcome, kind).toBe("requires_approval");

      const blocked = decideAction(
        [
          layer("installation", [field("scheduler.max_concurrency", "hard_ceiling", 4)]),
          layer("project", [field("scheduler.max_concurrency", "project_default", 4)]),
        ],
        schedulerAction(kind),
      );
      expect(blocked.outcome, kind).toBe("block");
    }
  });

  it("satisfies requires_approval only through a control-plane approval binding", () => {
    for (const kind of SCHEDULER_POLICY_ACTION_KINDS) {
      const layers = [layer("pack", [field("approvals.required", "approval_union", [kind])])];
      const satisfied = decideAction(layers, {
        ...schedulerAction(kind),
        approval_digest: APPROVAL,
      });
      expect(satisfied.outcome, kind).toBe("allow");
      expect(satisfied.approval_digest, kind).toBe(APPROVAL);
    }
  });

  it("lets prompt-origin scheduler input never carry approval authority", () => {
    for (const kind of SCHEDULER_POLICY_ACTION_KINDS) {
      const layers = [layer("pack", [field("approvals.required", "approval_union", [kind])])];
      const promptCarried = decideAction(layers, {
        ...schedulerAction(kind),
        origin: "prompt",
        actor: "adapter_01",
        actor_kind: "adapter",
        approval_digest: APPROVAL,
      });
      // The same approval that satisfies a control-plane action is
      // meaningless when untrusted context carries it.
      expect(promptCarried.outcome, kind).toBe("deny");
      expect(promptCarried.approval_digest, kind).toBeUndefined();
    }
  });
});

describe("scheduler policy ceilings", () => {
  it("defaults to the profile concurrency of 2 and no iteration ceilings when undeclared", () => {
    const resolution = resolveSchedulerCeilings(mergePolicyLayers([]).effective);
    expect(resolution).toMatchObject({
      outcome: "resolved",
      ceilings: { max_concurrency: PROFILE_DEFAULT_MAX_CONCURRENCY, iteration: {} },
    });
    expect(PROFILE_DEFAULT_MAX_CONCURRENCY).toBe(2);
  });

  it("falls back to the effective loop budgets for missing iteration ceilings", () => {
    const { effective } = mergePolicyLayers([
      layer("pack", [
        field("loop.max_steps", "hard_ceiling", 40),
        field("loop.max_tokens", "hard_ceiling", 200_000),
        field("loop.max_duration_ms", "hard_ceiling", 3_600_000),
      ]),
    ]);
    const resolution = resolveSchedulerCeilings(effective);
    expect(resolution).toMatchObject({
      outcome: "resolved",
      ceilings: {
        max_concurrency: 2,
        iteration: { max_steps: 40, max_tokens: 200_000, max_duration_ms: 3_600_000 },
      },
    });
  });

  it("takes the merged minimum of explicit hard ceilings", () => {
    const { effective } = mergePolicyLayers([
      layer("installation", [
        field("scheduler.max_concurrency", "hard_ceiling", 4),
        field("budgets.iteration.max_steps", "hard_ceiling", 80),
      ]),
      layer("project", [
        field("scheduler.max_concurrency", "hard_ceiling", 3),
        field("budgets.iteration.max_steps", "hard_ceiling", 120),
        field("budgets.iteration.max_tokens", "hard_ceiling", 150_000),
      ]),
      layer("pack", [field("loop.max_steps", "hard_ceiling", 40)]),
    ]);
    const resolution = resolveSchedulerCeilings(effective);
    expect(resolution).toMatchObject({
      outcome: "resolved",
      ceilings: {
        max_concurrency: 3,
        // An explicit iteration ceiling beats the loop fallback; the
        // undeclared duration ceiling falls back to nothing.
        iteration: { max_steps: 80, max_tokens: 150_000 },
      },
    });
    expect(
      resolution.outcome === "resolved" &&
        resolution.ceilings.iteration.max_duration_ms === undefined,
    ).toBe(true);
  });

  it("blocks on a non-positive explicit ceiling instead of silently falling back", () => {
    for (const path of [
      "scheduler.max_concurrency",
      "budgets.iteration.max_steps",
      "budgets.iteration.max_tokens",
      "budgets.iteration.max_duration_ms",
    ]) {
      for (const value of [0, -3]) {
        const { effective } = mergePolicyLayers([
          layer("project", [field(path, "hard_ceiling", value)]),
          layer("pack", [field("loop.max_steps", "hard_ceiling", 40)]),
        ]);
        const resolution = resolveSchedulerCeilings(effective);
        expect(resolution.outcome, `${path}=${value}`).toBe("blocked");
        expect(resolution.reasons.join("\n"), `${path}=${value}`).toContain(path);
      }
    }
  });

  it("blocks on a non-numeric or non-integer ceiling value", () => {
    const nonNumeric = mergePolicyLayers([
      layer("project", [field("budgets.iteration.max_tokens", "project_default", "many")]),
    ]);
    expect(resolveSchedulerCeilings(nonNumeric.effective).outcome).toBe("blocked");

    const fractional = mergePolicyLayers([
      layer("project", [field("scheduler.max_concurrency", "hard_ceiling", 2.5)]),
    ]);
    const resolution = resolveSchedulerCeilings(fractional.effective);
    expect(resolution.outcome).toBe("blocked");
    expect(resolution.reasons.join("\n")).toContain("scheduler.max_concurrency");
  });

  it("surfaces merge conflicts on the new ceiling paths as block decisions", () => {
    const decision = decideAction(
      [layer("installation", [field("budgets.iteration.max_steps", "hard_ceiling", "80")])],
      schedulerAction("dispatch_task"),
    );
    expect(decision.outcome).toBe("block");
    expect(decision.reasons.join("\n")).toContain("budgets.iteration.max_steps");
  });
});
