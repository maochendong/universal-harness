import { describe, expect, it } from "vitest";

import {
  SCHEDULER_POLICY_ACTION_KINDS,
  PolicyError,
  actionDigest,
} from "../../src/policy/action.js";
import { issueGrant, type CapabilityGrant } from "../../src/policy/capability-grant.js";
import { buildDecision, type PolicyLayerInput } from "../../src/policy/decision.js";
import { decideAction, mergePolicyLayers } from "../../src/policy/evaluator.js";
import { SchedulingPortError, type SchedulerPolicyInput } from "../../src/scheduling/ports.js";
import {
  createInMemoryPolicyDecisionPort,
  createPolicyDecisionAdapter,
  schedulerPolicyAction,
} from "../../src/scheduling/policy-adapters.js";
import { MANAGED_PROFILE, field, layer } from "../policy/fixtures.js";

/**
 * Plan Task 4 step 4: PolicyDecisionPort unit tests. The observable outcome
 * matrix (three actions x four outcomes, approval binding) lives in the
 * conformance suite; these tests pin the canonical normalization, the digest
 * bindings and the InMemory Adapter's fail-closed validation.
 */

const digest = (letter: string): string => letter.repeat(64);
const BASELINE = "0123456789abcdef0123456789abcdef01234567";
const APPROVAL = digest("a");

function schedulerInput(
  layers: readonly PolicyLayerInput[],
  overrides: Partial<SchedulerPolicyInput> = {},
): SchedulerPolicyInput {
  const merged: Record<string, unknown> = {
    action: "dispatch_task",
    operation_id: "operation_unit_policy",
    iteration_id: "iteration_unit_policy",
    plan_digest: digest("b"),
    task_digest: digest("t"),
    wave_index: 0,
    baseline_commit: BASELINE,
    risk: "medium",
    capabilities: ["edit-source"],
    tools: ["apply_patch"],
    write_paths: ["src/alpha"],
    exclusive_resources: [],
    task_remaining_budget: { steps: 10, tokens: 20_000, duration_ms: 600_000 },
    iteration_remaining_budget: { steps: 40, tokens: 80_000, duration_ms: 3_600_000 },
    adapter_manifest_digest: digest("m"),
    adapter_control_profile: MANAGED_PROFILE,
    effective_policy_digest: mergePolicyLayers(layers).effective.digest,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as unknown as SchedulerPolicyInput;
}

function executeGrant(
  layers: readonly PolicyLayerInput[],
  approvalDigests: readonly string[] = [],
): CapabilityGrant {
  return issueGrant(
    {
      grant_id: "grant_unit",
      task_id: "task_alpha",
      capabilities: [],
      read_paths: [],
      write_paths: [],
      tools: [],
      phase: "execute",
      budget: { steps: 10, tokens: 20_000 },
      approval_digests: approvalDigests,
    },
    mergePolicyLayers(layers).effective,
  );
}

describe("schedulerPolicyAction", () => {
  it("maps every SchedulerPolicyInput binding into canonical parameters", () => {
    const input = schedulerInput([], {
      action: "retry_task",
      retry_kind: "executor_retry",
      approval_digest: APPROVAL,
      // Deliberately unsorted: canonical form sorts every array.
      capabilities: ["review-source", "edit-source"],
      tools: ["run_tests", "apply_patch"],
      write_paths: ["src/beta", "src/alpha"],
      exclusive_resources: ["service-port:8080", "database-schema"],
    });
    const action = schedulerPolicyAction(input);
    expect(action.kind).toBe("retry_task");
    expect(action.actor).toBe("harness");
    expect(action.actor_kind).toBe("harness");
    expect(action.origin).toBe("control_plane");
    expect(action.phase).toBe("execute");
    expect(action.risk).toBe("medium");
    expect(action.approval_digest).toBe(APPROVAL);
    expect(action.control_profile).toEqual(MANAGED_PROFILE);
    expect(action.parameters).toEqual({
      operation_id: "operation_unit_policy",
      iteration_id: "iteration_unit_policy",
      plan_digest: digest("b"),
      task_digest: digest("t"),
      wave_index: 0,
      baseline_commit: BASELINE,
      capabilities: ["edit-source", "review-source"],
      tools: ["apply_patch", "run_tests"],
      write_paths: ["src/alpha", "src/beta"],
      exclusive_resources: ["database-schema", "service-port:8080"],
      task_remaining_budget: { steps: 10, tokens: 20_000, duration_ms: 600_000 },
      iteration_remaining_budget: { steps: 40, tokens: 80_000, duration_ms: 3_600_000 },
      adapter_manifest_digest: digest("m"),
      retry_kind: "executor_retry",
    });
  });

  it("binds optional fields as explicit nulls so the digest is total", () => {
    const action = schedulerPolicyAction(
      schedulerInput([], {
        action: "integrate_wave",
        task_digest: undefined,
        task_remaining_budget: undefined,
      }),
    );
    expect(action.parameters.task_digest).toBeNull();
    expect(action.parameters.task_remaining_budget).toBeNull();
    expect(action.parameters.retry_kind).toBeNull();
    expect(action.approval_digest).toBeUndefined();
  });

  it("is digest-stable across parameter array ordering", () => {
    const first = schedulerPolicyAction(
      schedulerInput([], { capabilities: ["b-cap", "a-cap"], tools: ["z-tool", "a-tool"] }),
    );
    const second = schedulerPolicyAction(
      schedulerInput([], { capabilities: ["a-cap", "b-cap"], tools: ["a-tool", "z-tool"] }),
    );
    expect(actionDigest(first)).toBe(actionDigest(second));
    expect(actionDigest(first)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires the binding each action kind needs", () => {
    for (const kind of ["dispatch_task", "retry_task"] as const) {
      expect(() =>
        schedulerPolicyAction(
          schedulerInput([], {
            action: kind,
            task_digest: undefined,
            retry_kind: "executor_retry",
          }),
        ),
      ).toThrowError(PolicyError);
    }
    expect(() =>
      schedulerPolicyAction(
        schedulerInput([], { action: "integrate_wave", wave_index: undefined }),
      ),
    ).toThrowError(PolicyError);
    expect(() => schedulerPolicyAction(schedulerInput([], { action: "retry_task" }))).toThrowError(
      PolicyError,
    );
    try {
      schedulerPolicyAction(schedulerInput([], { action: "retry_task" }));
      expect.unreachable();
    } catch (error) {
      expect((error as PolicyError).kind).toBe("invalid_action");
    }
  });

  it("rejects a non-scheduler action kind fail-closed", () => {
    expect(() =>
      schedulerPolicyAction(schedulerInput([], { action: "write_path" as never })),
    ).toThrowError(PolicyError);
  });
});

describe("createPolicyDecisionAdapter", () => {
  it("delegates to decideAction with the normalized control-plane action", async () => {
    const layers = [
      layer("pack", [field("approvals.required", "approval_union", ["dispatch_task"])]),
    ];
    const seen: string[] = [];
    const port = createPolicyDecisionAdapter({
      readLayers: () => layers,
      readGrant: (taskKey) => {
        seen.push(String(taskKey));
        return executeGrant(layers, [APPROVAL]);
      },
    });
    expect(port.name).toContain("policy");
    const input = schedulerInput(layers, { approval_digest: APPROVAL });
    const decision = await port.decide(input);
    expect(decision.outcome).toBe("allow");
    expect(decision.approval_digest).toBe(APPROVAL);
    expect(seen).toEqual([digest("t")]);
    expect(decision.action_digest).toBe(actionDigest(schedulerPolicyAction(input)));
    expect(decision.effective_policy_digest).toBe(mergePolicyLayers(layers).effective.digest);
  });

  it("blocks a request whose effective policy digest drifted", async () => {
    const layers = [
      layer("pack", [field("approvals.required", "approval_union", ["dispatch_task"])]),
    ];
    const port = createPolicyDecisionAdapter({
      readLayers: () => layers,
      readGrant: () => undefined,
    });
    const input = schedulerInput(layers, {
      approval_digest: APPROVAL,
      effective_policy_digest: digest("0"),
    });
    const decision = await port.decide(input);
    expect(decision.outcome).toBe("block");
    expect(decision.approval_digest).toBeUndefined();
    expect(decision.reasons.join("\n")).toContain(digest("0"));
    expect(decision.reasons.join("\n")).toContain(mergePolicyLayers(layers).effective.digest);
    expect(decision.effective_policy_digest).toBe(mergePolicyLayers(layers).effective.digest);
  });

  it("denies when the grant binds a stale effective policy digest", async () => {
    const currentLayers = [
      layer("pack", [field("approvals.required", "approval_union", ["dispatch_task"])]),
    ];
    const staleGrant = executeGrant(
      [layer("pack", [field("phases.allow", "allow_intersection", ["execute"])], 2)],
      [APPROVAL],
    );
    const port = createPolicyDecisionAdapter({
      readLayers: () => currentLayers,
      readGrant: () => staleGrant,
    });
    const decision = await port.decide(
      schedulerInput(currentLayers, { approval_digest: APPROVAL }),
    );
    expect(decision.outcome).toBe("deny");
  });

  it("never lets an approval override deny or block", async () => {
    const deniedLayers = [
      layer("project", [field("phases.allow", "allow_intersection", ["plan"])]),
    ];
    const deniedPort = createPolicyDecisionAdapter({
      readLayers: () => deniedLayers,
      readGrant: () => undefined,
    });
    const denied = await deniedPort.decide(
      schedulerInput(deniedLayers, { approval_digest: APPROVAL }),
    );
    expect(denied.outcome).toBe("deny");

    const conflictedLayers = [
      layer("installation", [field("scheduler.max_concurrency", "hard_ceiling", 4)]),
      layer("project", [field("scheduler.max_concurrency", "project_default", 4)]),
    ];
    const blockedPort = createPolicyDecisionAdapter({
      readLayers: () => conflictedLayers,
      readGrant: () => undefined,
    });
    const blocked = await blockedPort.decide(
      schedulerInput(conflictedLayers, { approval_digest: APPROVAL }),
    );
    expect(blocked.outcome).toBe("block");
  });
});

describe("createInMemoryPolicyDecisionPort", () => {
  it("returns the resolver decision when both digests bind the request", async () => {
    const layers: readonly PolicyLayerInput[] = [];
    const port = createInMemoryPolicyDecisionPort({
      resolve: (action) => decideAction(layers, action),
    });
    expect(port.name).toContain("in-memory");
    const input = schedulerInput(layers);
    const decision = await port.decide(input);
    expect(decision.outcome).toBe("allow");
    expect(decision.action_digest).toBe(actionDigest(schedulerPolicyAction(input)));
  });

  it("throws when the resolver answers a different action", async () => {
    const layers: readonly PolicyLayerInput[] = [];
    const port = createInMemoryPolicyDecisionPort({
      resolve: () =>
        buildDecision({
          outcome: "allow",
          reasons: ["forged"],
          action_digest: digest("0"),
          effective: mergePolicyLayers(layers).effective,
        }),
    });
    try {
      await port.decide(schedulerInput(layers));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulingPortError);
      expect((error as SchedulingPortError).kind).toBe("invalid_decision");
    }
  });

  it("throws when the resolver decision binds a different effective policy", async () => {
    const layers: readonly PolicyLayerInput[] = [];
    const port = createInMemoryPolicyDecisionPort({
      resolve: (action) =>
        buildDecision({
          outcome: "allow",
          reasons: ["forged"],
          action_digest: actionDigest(action),
          effective: mergePolicyLayers([
            layer("pack", [field("phases.allow", "allow_intersection", ["execute"])]),
          ]).effective,
        }),
    });
    try {
      await port.decide(schedulerInput(layers));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulingPortError);
      expect((error as SchedulingPortError).kind).toBe("invalid_decision");
    }
  });

  it("produces the same action digest as the production Adapter for the same input", async () => {
    const layers = [layer("pack", [field("approvals.required", "approval_union", ["retry_task"])])];
    const input = schedulerInput(layers, {
      action: "retry_task",
      retry_kind: "integration_retry",
      approval_digest: APPROVAL,
    });
    const production = createPolicyDecisionAdapter({
      readLayers: () => layers,
      readGrant: () => executeGrant(layers, [APPROVAL]),
    });
    const inMemory = createInMemoryPolicyDecisionPort({
      resolve: (action) => decideAction(layers, action, executeGrant(layers, [APPROVAL])),
    });
    const [first, second] = await Promise.all([production.decide(input), inMemory.decide(input)]);
    expect(second.action_digest).toBe(first.action_digest);
    expect(second.effective_policy_digest).toBe(first.effective_policy_digest);
    expect(second.outcome).toBe(first.outcome);
    expect(second.outcome).toBe("allow");
  });
});

describe("scheduler policy action vocabulary coverage", () => {
  it("normalizes every declared scheduler action kind", () => {
    for (const kind of SCHEDULER_POLICY_ACTION_KINDS) {
      const action = schedulerPolicyAction(
        schedulerInput([], {
          action: kind,
          ...(kind === "retry_task" ? { retry_kind: "executor_retry" as const } : {}),
        }),
      );
      expect(action.kind).toBe(kind);
    }
  });
});
