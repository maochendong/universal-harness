import { describe, expect, it } from "vitest";

import {
  adapterFailureDecision,
  budgetCeilingDecision,
  cancellationDecision,
  completionDecision,
  LoopPhaseMachine,
  repeatDetectionDecision,
  timeoutDecision,
} from "../../src/loop/outcome.js";
import { LoopError } from "../../src/loop/policy.js";

describe("terminal decision builders", () => {
  it("map every exit cause to an outcome and an independent reason", () => {
    expect(completionDecision(true)).toMatchObject({
      outcome: "success",
      termination_reason: "completion",
    });
    expect(completionDecision(false)).toMatchObject({
      outcome: "failed",
      termination_reason: "gate_failure",
    });
    expect(budgetCeilingDecision("steps").termination_reason).toBe("budget_ceiling");
    expect(budgetCeilingDecision("tokens").outcome).toBe("partial");
    expect(repeatDetectionDecision("f".repeat(64))).toMatchObject({
      outcome: "partial",
      termination_reason: "repeat_detection",
    });
    expect(timeoutDecision()).toMatchObject({ outcome: "partial", termination_reason: "timeout" });
    expect(adapterFailureDecision("boom")).toMatchObject({
      outcome: "failed",
      termination_reason: "adapter_failure",
    });
    expect(cancellationDecision()).toMatchObject({
      outcome: "handoff",
      termination_reason: "user_cancellation",
    });
  });
});

describe("LoopPhaseMachine", () => {
  it("moves a completion signal into verifying, never into success", () => {
    const machine = new LoopPhaseMachine();
    expect(machine.phase).toBe("running");
    machine.signalCompletion();
    expect(machine.phase).toBe("verifying");
    expect(machine.terminal).toBeUndefined();
  });

  it("produces success only through evidence verification", () => {
    const machine = new LoopPhaseMachine();
    machine.signalCompletion();
    const decision = machine.verify(true);
    expect(decision).toMatchObject({ outcome: "success", termination_reason: "completion" });
    expect(machine.phase).toBe("terminated");
    expect(machine.terminal).toEqual(decision);
  });

  it("fails the run when the completion signal cannot be verified", () => {
    const machine = new LoopPhaseMachine();
    machine.signalCompletion();
    expect(machine.verify(false)).toMatchObject({
      outcome: "failed",
      termination_reason: "gate_failure",
    });
  });

  it("rejects a directly terminated success outcome", () => {
    const machine = new LoopPhaseMachine();
    expect(() =>
      machine.terminate({
        outcome: "success",
        termination_reason: "completion",
        detail: "self-reported",
      }),
    ).toThrowError(LoopError);
    expect(machine.phase).toBe("running");
  });

  it("rejects verification outside the verifying phase", () => {
    const machine = new LoopPhaseMachine();
    expect(() => machine.verify(true)).toThrowError(LoopError);
  });

  it("rejects a second completion signal and a second terminal decision", () => {
    const machine = new LoopPhaseMachine();
    machine.signalCompletion();
    expect(() => machine.signalCompletion()).toThrowError(LoopError);
    machine.verify(true);
    expect(() => machine.terminate(timeoutDecision())).toThrowError(/exactly one terminal/u);
    const direct = new LoopPhaseMachine();
    direct.terminate(timeoutDecision());
    expect(() => direct.terminate(timeoutDecision())).toThrowError(LoopError);
  });
});
