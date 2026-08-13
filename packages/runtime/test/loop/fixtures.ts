import { contentDigest } from "@universal-harness-internal/core";

import type {
  LoopToolCall,
  ManagedLoopDependencies,
  ModelStep,
  TaskEnvelope,
} from "../../src/index.js";
import {
  buildTaskEnvelope,
  issueGrant,
  mergePolicyLayers,
  resolveLoopPolicy,
  type CapabilityGrant,
  type LoopPolicyOverrides,
  type WorkingState,
} from "../../src/index.js";
import type { ToolInvocationEvidence } from "../../src/tools/invocation.js";
import type { PolicyFieldInput } from "../../src/policy/decision.js";
import { field, grantRequest, layer } from "../policy/fixtures.js";

/** Shared deterministic builders for loop tests (fake clock, fake meter). */
export function effectiveWith(fields: readonly PolicyFieldInput[]) {
  return mergePolicyLayers([layer("project", fields)]).effective;
}

export const POLICY_FIELD = field;

export function makeState(overrides?: Partial<WorkingState>): WorkingState {
  return {
    goal: "implement the feature",
    baseline_commit: "0123456789abcdef0123456789abcdef01234567",
    requirement_baseline_digest: "a".repeat(64),
    policy_digest: "b".repeat(64),
    phase: "implementation",
    confirmed_facts: [],
    rejected_hypotheses: [],
    open_questions: [],
    blockers: [],
    completed_task_ids: [],
    pending_task_ids: ["task_alpha"],
    budget: { used_steps: 0, used_tokens: 0, ceiling_steps: 100, ceiling_tokens: 100000 },
    capability_grants: [],
    approval_digests: [],
    input_digests: [],
    external_action_intents: [],
    ...overrides,
  };
}

export function makeGrant(budget?: { steps: number; tokens: number }): CapabilityGrant {
  return issueGrant(
    grantRequest({ ...(budget === undefined ? {} : { budget }) }),
    effectiveWith([]),
  );
}

export function makeEnvelope(
  overrides?: Partial<TaskEnvelope> & { loop_overrides?: LoopPolicyOverrides },
): TaskEnvelope {
  const { loop_overrides, ...rest } = overrides ?? {};
  return buildTaskEnvelope({
    task_id: "task_alpha",
    plan_id: "plan_01",
    iteration_id: "iteration_01",
    repository_id: "repo_01",
    baseline_id: "baseline_01",
    objective: "implement the feature",
    expected_output: "a passing test suite",
    acceptance_criteria: ["tests pass"],
    dependency_task_ids: [],
    required_gate_ids: [],
    input_node_revisions: {},
    context_bundle_id: "bundle_01",
    context_bundle_digest: "c".repeat(64),
    protected_context_fields: ["goal"],
    allowed_read_paths: ["src"],
    proposed_write_paths: ["src"],
    state_read_fields: ["confirmed_facts"],
    state_proposal_fields: ["confirmed_facts"],
    tools: [{ name: "apply_patch" }],
    risk: "low",
    required_approval_digests: [],
    external_side_effect: "forbidden",
    idempotency_scope: "task_alpha",
    loop_policy: resolveLoopPolicy(effectiveWith([]), {
      overrides: loop_overrides ?? { max_steps: 3, max_tokens: 1000, max_duration_ms: 60000 },
      // Fixture envelopes are authorized, so governance-weakening overrides
      // resolve; the authorization requirement itself is covered by the
      // policy tests.
      authorization_digest: "f".repeat(64),
    }),
    baseline_commit: "0123456789abcdef0123456789abcdef01234567",
    input_digest: "d".repeat(64),
    stale_input_behavior: "block",
    ...rest,
  });
}

export function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

export function fakeMeter(start = 0): { usedTokens: () => number; add: (n: number) => void } {
  let tokens = start;
  return {
    usedTokens: () => tokens,
    add: (n: number) => {
      tokens += n;
    },
  };
}

export function toolEvidence(output: unknown, tool = "apply_patch@1.0.0"): ToolInvocationEvidence {
  return {
    tool,
    request_digest: contentDigest({ tool }),
    output,
    output_digest: contentDigest(output ?? null),
    attempts: 1,
    redacted: false,
    replayed: false,
    intent: null,
  };
}

export interface FakeDeps {
  readonly deps: ManagedLoopDependencies;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly meter: ReturnType<typeof fakeMeter>;
}

export function makeDeps(overrides?: {
  step?: ModelStep;
  invokeTool?: ManagedLoopDependencies["invokeTool"];
  verify?: () => boolean;
  isCancelled?: () => boolean;
  clock?: ReturnType<typeof fakeClock>;
  meter?: ReturnType<typeof fakeMeter>;
  state?: WorkingState;
  grant?: CapabilityGrant;
}): FakeDeps {
  const clock = overrides?.clock ?? fakeClock();
  const meter = overrides?.meter ?? fakeMeter();
  const deps: ManagedLoopDependencies = {
    clock: clock.now,
    usage: meter,
    step: overrides?.step ?? (() => ({ kind: "complete" })),
    invokeTool: overrides?.invokeTool ?? (() => Promise.resolve(toolEvidence({ ok: true }))),
    verify: overrides?.verify ?? (() => true),
    ...(overrides?.isCancelled === undefined ? {} : { isCancelled: overrides.isCancelled }),
    initialState: overrides?.state ?? makeState(),
    initialGrant: overrides?.grant ?? makeGrant(),
  };
  return { deps, clock, meter };
}

export function workWith(call: LoopToolCall): {
  kind: "work";
  tool_calls: readonly LoopToolCall[];
} {
  return { kind: "work", tool_calls: [call] };
}
