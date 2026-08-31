import { describe, expect, it } from "vitest";

import {
  assessUnattendedEligibility,
  type AgentAdapter,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentTaskEnvelope,
} from "../src/index.js";

function envelope(): AgentTaskEnvelope {
  return {
    task_id: "task-1",
    plan_id: "plan-1",
    iteration_id: "iteration-1",
    repository_id: "repo-1",
    objective: "Implement the greeting module",
    expected_output: "A greeting module with tests",
    acceptance_criteria: ["greeting module exists"],
    required_gate_ids: [],
    allowed_read_paths: ["src"],
    proposed_write_paths: ["src"],
    state_proposal_fields: ["summary"],
    baseline_commit: "0123456789abcdef0123456789abcdef01234567",
    input_digest: "a".repeat(64),
    digest: "b".repeat(64),
    loop_policy: { max_steps: 30, max_tokens: 120000, max_duration_ms: 2700000 },
  };
}

function stubResult(): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: "done",
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      duration_ms: 1,
      metering: "unmetered",
    },
    evidence: [],
    undeclared_writes: [],
  };
}

describe("agent run options cancellation signal", () => {
  it("carries an optional AbortSignal through to the adapter unchanged", async () => {
    const observed: AgentRunOptions[] = [];
    const adapter: AgentAdapter = {
      name: "stub",
      manifest: {
        provider: "stub",
        control: "managed",
        trajectory_visibility: "full",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "explicit",
      },
      run: (_envelope, options) => {
        observed.push(options);
        return Promise.resolve(stubResult());
      },
    };
    const controller = new AbortController();

    await adapter.run(envelope(), { mode: "supervised", signal: controller.signal });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.signal).toBe(controller.signal);
  });

  it("keeps the signal optional for every existing caller shape", async () => {
    const observed: AgentRunOptions[] = [];
    const adapter: AgentAdapter = {
      name: "stub",
      manifest: {
        provider: "stub",
        control: "managed",
        trajectory_visibility: "full",
        usage_metering: true,
        side_effect_interception: true,
        resume_semantics: "explicit",
      },
      run: (_envelope, options) => {
        observed.push(options);
        return Promise.resolve(stubResult());
      },
    };

    await adapter.run(envelope(), { mode: "supervised" });
    await adapter.run(envelope(), {
      mode: "unattended",
      resume: { note: "resume", prior_evidence: [] },
      on_output: () => undefined,
    });

    expect(observed[0]?.signal).toBeUndefined();
    expect(observed[1]?.signal).toBeUndefined();
  });

  it("an adapter that ignores the signal still satisfies the port contract", async () => {
    // Termination-unconfirmed semantics: the adapter may never observe the
    // signal; the caller must reconcile from the returned result, never from
    // the abort intent alone.
    const adapter: AgentAdapter = {
      name: "oblivious",
      manifest: {
        provider: "stub",
        control: "manual",
        trajectory_visibility: "external-only",
        usage_metering: false,
        side_effect_interception: false,
        resume_semantics: "none",
      },
      run: () => Promise.resolve(stubResult()),
    };
    const controller = new AbortController();
    const running = adapter.run(envelope(), { mode: "supervised", signal: controller.signal });
    controller.abort();
    const result = await running;

    expect(result.termination_reason).toBe("completion");
    expect(assessUnattendedEligibility(adapter.manifest).eligible).toBe(false);
  });
});
