import { describe, expect, it } from "vitest";

import { runManagedLoop, type ModelStep } from "../../src/loop/controller.js";
import { ToolError } from "../../src/tools/definition.js";
import type { WorkingStateProposal } from "../../src/workflow/working-state.js";

import {
  fakeClock,
  fakeMeter,
  makeDeps,
  makeEnvelope,
  makeGrant,
  makeState,
  toolEvidence,
  workWith,
} from "./fixtures.js";

const CALL = { tool: "apply_patch@1.0.0", parameters: { path: "src/a.ts" } } as const;

describe("runManagedLoop success path", () => {
  it("verifies a completion signal against evidence before succeeding", async () => {
    let turn = 0;
    const step: ModelStep = () => {
      turn += 1;
      if (turn === 1) {
        return {
          kind: "work",
          tool_calls: [CALL],
          proposal: {
            add_confirmed_facts: [{ fact: "patch applied", evidence_id: "ev_1" }],
          },
        };
      }
      return { kind: "complete" };
    };
    const { deps } = makeDeps({ step });
    const result = await runManagedLoop(makeEnvelope(), deps);
    expect(result.decision).toMatchObject({
      outcome: "success",
      termination_reason: "completion",
    });
    expect(result.steps_executed).toBe(2);
    expect(result.final_state.confirmed_facts).toEqual([
      { fact: "patch applied", evidence_id: "ev_1" },
    ]);
    expect(result.final_state.budget.used_steps).toBe(1);
    const kinds = result.events.map((event) => event.kind);
    expect(kinds).toContain("completion_signaled");
    expect(kinds.filter((kind) => kind === "terminated")).toHaveLength(1);
  });

  it("fails the run when mandatory evidence is not current", async () => {
    const { deps } = makeDeps({ verify: () => false });
    const result = await runManagedLoop(makeEnvelope(), deps);
    expect(result.decision).toMatchObject({
      outcome: "failed",
      termination_reason: "gate_failure",
    });
  });

  it("skips verification only when the authorized policy waives it", async () => {
    let verified = 0;
    const { deps } = makeDeps({
      verify: () => {
        verified += 1;
        return false;
      },
    });
    const waived = makeEnvelope({
      loop_overrides: { termination: { require_external_verification: false } },
    });
    const result = await runManagedLoop(waived, deps);
    expect(verified).toBe(0);
    expect(result.decision).toMatchObject({
      outcome: "success",
      termination_reason: "completion",
    });
    // With the default policy the same verifier failure is a gate failure.
    const strict = await runManagedLoop(makeEnvelope(), deps);
    expect(strict.decision.outcome).toBe("failed");
  });

  it("narrows the capability grant after every executed step", async () => {
    let turn = 0;
    const grant = makeGrant({ steps: 20, tokens: 50000 });
    const step: ModelStep = (input) => {
      turn += 1;
      if (turn === 1) return workWith(CALL);
      expect(input.grant.budget.steps).toBeLessThan(grant.budget.steps);
      return { kind: "complete" };
    };
    const { deps } = makeDeps({ step, grant });
    const result = await runManagedLoop(makeEnvelope(), deps);
    expect(result.final_grant.budget.steps).toBeLessThan(grant.budget.steps);
    expect(result.events.some((event) => event.kind === "grant_narrowed")).toBe(true);
  });
});

describe("runManagedLoop ceilings", () => {
  it("stops at the step ceiling with a budget_ceiling termination", async () => {
    const step: ModelStep = () => ({ kind: "work" });
    const { deps } = makeDeps({ step });
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 2 } });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision).toMatchObject({
      outcome: "partial",
      termination_reason: "budget_ceiling",
    });
    expect(result.steps_executed).toBe(2);
  });

  it("stops at the token ceiling reported by the usage meter", async () => {
    const meter = fakeMeter();
    const step: ModelStep = () => {
      meter.add(600);
      return { kind: "work" };
    };
    const { deps } = makeDeps({ step, meter });
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 10, max_tokens: 1000 } });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision.termination_reason).toBe("budget_ceiling");
    expect(result.decision.detail).toContain("tokens");
  });

  it("stops at the duration ceiling on the fake clock", async () => {
    const clock = fakeClock();
    const step: ModelStep = () => {
      clock.advance(70000);
      return { kind: "work" };
    };
    const { deps } = makeDeps({ step, clock });
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 10, max_duration_ms: 60000 } });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision).toMatchObject({ outcome: "partial", termination_reason: "timeout" });
  });

  it("stops at the WorkingState budget ceiling even below the loop ceiling", async () => {
    const step: ModelStep = () => ({ kind: "work" });
    const state = makeState({
      budget: { used_steps: 0, used_tokens: 0, ceiling_steps: 2, ceiling_tokens: 100000 },
    });
    const { deps } = makeDeps({ step, state });
    const result = await runManagedLoop(makeEnvelope({ loop_overrides: { max_steps: 10 } }), deps);
    expect(result.decision.termination_reason).toBe("budget_ceiling");
    expect(result.final_state.budget.used_steps).toBe(2);
  });

  it("soft ceiling terminates after the in-flight step completes", async () => {
    const step: ModelStep = () => ({
      kind: "work",
      proposal: { add_open_questions: ["still open"] },
    });
    const { deps } = makeDeps({ step });
    const soft = makeEnvelope({
      loop_overrides: { max_steps: 1, termination: { budget_ceiling: "soft" } },
    });
    const result = await runManagedLoop(soft, deps);
    expect(result.decision.termination_reason).toBe("budget_ceiling");
    expect(result.steps_executed).toBe(1);
    // The in-flight step's typed proposal was applied before terminating.
    expect(result.final_state.open_questions).toEqual(["still open"]);
  });

  it("cancels into a handoff before any step runs", async () => {
    const { deps } = makeDeps({ isCancelled: () => true });
    const result = await runManagedLoop(makeEnvelope(), deps);
    expect(result.decision).toMatchObject({
      outcome: "handoff",
      termination_reason: "user_cancellation",
    });
    expect(result.steps_executed).toBe(0);
  });
});

describe("runManagedLoop tool retry and failure mapping", () => {
  it("retries a failed tool call up to the policy retry ceiling", async () => {
    let attempts = 0;
    const { deps } = makeDeps({
      step: () => ({ kind: "work", tool_calls: [CALL] }),
      invokeTool: () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(new ToolError("tool_failed", `failure ${String(attempts)}`));
        }
        return Promise.resolve(toolEvidence({ ok: true }));
      },
    });
    const envelope = makeEnvelope({
      loop_overrides: { max_steps: 1, max_tool_retries: 2 },
    });
    const result = await runManagedLoop(envelope, deps);
    // The step ceiling ends the loop after the retried call finally succeeded.
    expect(attempts).toBe(3);
    expect(result.decision.termination_reason).toBe("budget_ceiling");
    expect(result.evidence).toHaveLength(1);
    expect(result.events.filter((event) => event.kind === "tool_retried")).toHaveLength(2);
  });

  it("terminates with adapter_failure when retries are exhausted", async () => {
    const { deps } = makeDeps({
      step: () => ({ kind: "work", tool_calls: [CALL] }),
      invokeTool: () => Promise.reject(new ToolError("tool_failed", "always broken")),
    });
    const envelope = makeEnvelope({
      loop_overrides: { max_steps: 5, max_tool_retries: 1 },
    });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision).toMatchObject({
      outcome: "failed",
      termination_reason: "adapter_failure",
    });
  });

  it("maps an exhausted tool timeout to a timeout termination", async () => {
    const { deps } = makeDeps({
      step: () => ({ kind: "work", tool_calls: [CALL] }),
      invokeTool: () => Promise.reject(new ToolError("timeout", "too slow")),
    });
    const result = await runManagedLoop(
      makeEnvelope({ loop_overrides: { max_steps: 5, max_tool_retries: 0 } }),
      deps,
    );
    expect(result.decision).toMatchObject({ outcome: "partial", termination_reason: "timeout" });
  });

  it("never blindly retries an uncertain external result", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      step: () => ({ kind: "work", tool_calls: [CALL] }),
      invokeTool: () => {
        calls += 1;
        return Promise.reject(new ToolError("uncertain_result", "maybe applied"));
      },
    });
    const result = await runManagedLoop(
      makeEnvelope({ loop_overrides: { max_steps: 5, max_tool_retries: 2 } }),
      deps,
    );
    expect(calls).toBe(1);
    expect(result.decision).toMatchObject({
      outcome: "partial",
      termination_reason: "adapter_failure",
    });
    expect(result.decision.detail).toContain("reconciled");
  });

  it("maps a governance denial to a correct block", async () => {
    const { deps } = makeDeps({
      step: () => ({ kind: "work", tool_calls: [CALL] }),
      invokeTool: () => Promise.reject(new ToolError("grant_violation", "outside the grant")),
    });
    const result = await runManagedLoop(makeEnvelope(), deps);
    expect(result.decision).toMatchObject({
      outcome: "correct_block",
      termination_reason: "policy_denial",
    });
  });
});

describe("runManagedLoop repeat detection", () => {
  it("terminates a repeated call trace with no state or evidence progress", async () => {
    const { deps } = makeDeps({
      step: () => ({ kind: "work", tool_calls: [CALL] }),
      invokeTool: () => Promise.resolve(toolEvidence({ same: true })),
    });
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 10 } });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision).toMatchObject({
      outcome: "partial",
      termination_reason: "repeat_detection",
    });
    // Default detection limit: the second stagnant identical call trips.
    expect(result.evidence).toHaveLength(2);
  });

  it("does not trip while evidence keeps progressing", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      step: () => ({ kind: "work", tool_calls: [CALL] }),
      invokeTool: () => {
        calls += 1;
        return Promise.resolve(toolEvidence({ unique: calls }));
      },
    });
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 4 } });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision.termination_reason).toBe("budget_ceiling");
    expect(result.evidence).toHaveLength(4);
  });

  it("does not trip while state keeps progressing", async () => {
    let turn = 0;
    const step: ModelStep = () => {
      turn += 1;
      return {
        kind: "work",
        tool_calls: [CALL],
        proposal: { add_open_questions: [`q${String(turn)}`] },
      };
    };
    const { deps } = makeDeps({
      step,
      invokeTool: () => Promise.resolve(toolEvidence({ same: true })),
    });
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 4 } });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision.termination_reason).toBe("budget_ceiling");
    expect(result.evidence).toHaveLength(4);
  });
});

describe("runManagedLoop model confinement", () => {
  it("rejects a model proposal that tries to meter its own budget", async () => {
    const proposal = {
      budget_use: { used_steps: -100 },
    } as unknown as WorkingStateProposal;
    const step: ModelStep = () => ({ kind: "work", proposal });
    const { deps } = makeDeps({ step });
    const result = await runManagedLoop(makeEnvelope(), deps);
    expect(result.decision).toMatchObject({
      outcome: "failed",
      termination_reason: "adapter_failure",
    });
    expect(result.decision.detail).toContain("budget_use");
    expect(result.final_state.budget.used_steps).toBe(0);
  });

  it("rejects a model proposal with unknown keys", async () => {
    const proposal = { raise_ceiling: true } as unknown as WorkingStateProposal;
    const step: ModelStep = () => ({ kind: "work", proposal });
    const { deps } = makeDeps({ step });
    const result = await runManagedLoop(makeEnvelope(), deps);
    expect(result.decision.termination_reason).toBe("adapter_failure");
    expect(result.decision.detail).toContain("raise_ceiling");
  });

  it("hands the model only frozen read views of state, grant and envelope", async () => {
    let mutationThrew = false;
    const step: ModelStep = (input) => {
      expect(Object.isFrozen(input.state)).toBe(true);
      expect(Object.isFrozen(input.grant)).toBe(true);
      expect(Object.isFrozen(input.envelope)).toBe(true);
      try {
        (input.state as { goal: string }).goal = "hacked";
      } catch {
        mutationThrew = true;
      }
      return { kind: "complete" };
    };
    const { deps } = makeDeps({ step });
    const result = await runManagedLoop(makeEnvelope(), deps);
    expect(mutationThrew).toBe(true);
    expect(result.final_state.goal).toBe("implement the feature");
  });

  it("converts a throwing model step into an adapter_failure termination", async () => {
    const step: ModelStep = () => {
      throw new Error("provider crashed");
    };
    const { deps } = makeDeps({ step });
    const result = await runManagedLoop(makeEnvelope(), deps);
    expect(result.decision).toMatchObject({
      outcome: "failed",
      termination_reason: "adapter_failure",
    });
    expect(result.decision.detail).toContain("provider crashed");
  });

  it("collects partial output separately from the terminal decision", async () => {
    const step: ModelStep = () => ({
      kind: "work",
      partial_output: { summary: "half of the patch applied", evidence_ids: ["ev_1"] },
    });
    const { deps } = makeDeps({ step });
    const result = await runManagedLoop(makeEnvelope({ loop_overrides: { max_steps: 1 } }), deps);
    expect(result.decision.outcome).toBe("partial");
    expect(result.partial_outputs).toEqual([
      { summary: "half of the patch applied", evidence_ids: ["ev_1"] },
    ]);
    expect(result.decision).not.toHaveProperty("partial_outputs");
  });
});
