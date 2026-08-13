import { describe, expect, it } from "vitest";

import { runManagedLoop, type LoopProgressEvent } from "../../packages/runtime/src/index.js";
import {
  fakeClock,
  fakeMeter,
  makeDeps,
  makeEnvelope,
  makeGrant,
  makeState,
} from "../../packages/runtime/test/loop/fixtures.js";

/**
 * Budget exhaustion fault injection (design 13.3, 15.2; completion rule 14).
 * The managed loop enforces step, token and duration ceilings without relying
 * on model compliance: a model that never stops is halted with exactly one
 * structured terminal decision, partial output produced so far is preserved,
 * and a model can never self-report or raise its own budget.
 */
function terminatedEvents(events: readonly LoopProgressEvent[]): LoopProgressEvent[] {
  return events.filter((event) => event.kind === "terminated");
}

describe("budget exhaustion", () => {
  it("halts a never-stopping model at the hard step ceiling", async () => {
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 3 } });
    const { deps } = makeDeps({
      step: (input) => ({
        kind: "work",
        partial_output: { summary: `progress at step ${String(input.step)}`, evidence_ids: [] },
      }),
    });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision).toMatchObject({
      outcome: "partial",
      termination_reason: "budget_ceiling",
    });
    expect(result.decision.detail).toContain("steps");
    expect(result.steps_executed).toBe(3);
    // Partial output is preserved for the caller, and exactly one terminal
    // decision was produced.
    expect(result.partial_outputs).toHaveLength(3);
    expect(terminatedEvents(result.events)).toHaveLength(1);
  });

  it("halts at the token ceiling using only the harness-side meter", async () => {
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 50, max_tokens: 100 } });
    const meter = fakeMeter();
    const { deps } = makeDeps({
      meter,
      step: () => {
        // The model burns 40 tokens per step; the meter is harness-owned, so
        // the model cannot under-report its way past the ceiling.
        meter.add(40);
        return { kind: "work" };
      },
    });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision).toMatchObject({
      outcome: "partial",
      termination_reason: "budget_ceiling",
    });
    expect(result.decision.detail).toContain("tokens");
    expect(result.tokens_used).toBeGreaterThanOrEqual(100);
    expect(terminatedEvents(result.events)).toHaveLength(1);
  });

  it("halts at the duration ceiling on the harness clock", async () => {
    const envelope = makeEnvelope({
      loop_overrides: { max_steps: 50, max_tokens: 100_000, max_duration_ms: 2_500 },
    });
    const clock = fakeClock();
    const { deps } = makeDeps({
      clock,
      step: () => {
        clock.advance(1_000);
        return { kind: "work" };
      },
    });
    const result = await runManagedLoop(envelope, deps);
    expect(result.decision).toMatchObject({ outcome: "partial", termination_reason: "timeout" });
    expect(result.duration_ms).toBeGreaterThanOrEqual(2_500);
    expect(terminatedEvents(result.events)).toHaveLength(1);
  });

  it("rejects a model proposal that tries to self-report budget usage", async () => {
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 5 } });
    const { deps } = makeDeps({
      step: () => ({
        kind: "work",
        proposal: { budget_use: { used_steps: 0, used_tokens: 0 } },
      }),
    });
    const result = await runManagedLoop(envelope, deps);
    // The proposal channel refuses budget_use; the run ends in a structured
    // failure, never in an accepted self-report.
    expect(result.decision.termination_reason).toBe("adapter_failure");
    expect(result.decision.detail).toContain("budget_use");
  });

  it("narrows the grant monotonically; no step can grow it back", async () => {
    const envelope = makeEnvelope({ loop_overrides: { max_steps: 4, max_tokens: 1_000 } });
    const grant = makeGrant({ steps: 40, tokens: 90_000 });
    const { deps } = makeDeps({
      grant,
      state: makeState(),
      step: (input) => {
        // The model observes a read-only, already-narrowed grant.
        expect(Object.isFrozen(input.grant)).toBe(true);
        return { kind: "work" };
      },
    });
    const result = await runManagedLoop(envelope, deps);
    expect(result.final_grant.budget.steps).toBeLessThanOrEqual(1);
    expect(result.final_grant.budget.steps).toBeLessThanOrEqual(grant.budget.steps);
    const narrowing = result.events.filter((event) => event.kind === "grant_narrowed");
    expect(narrowing.length).toBeGreaterThan(0);
  });
});
