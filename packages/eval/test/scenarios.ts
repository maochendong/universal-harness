import type {
  AgentRunOutcome,
  AgentRunResult,
  AgentTerminationReason,
} from "@universal-harness-internal/plugin-sdk";

import { defineEvaluationCase, type EvaluationCase, type EvaluationCaseSpec } from "../src/case.js";
import { evaluateRun, type EvaluationSpec, type RunEvaluationReport } from "../src/evaluator.js";
import type { RunEvaluationInput, TrajectoryStep } from "../src/scorer.js";

/**
 * Deterministic conformance scenarios (design 16.1, plan Task 20): success,
 * clarification, permission denial, malformed tool call, repeated tool call,
 * unrecoverable failure, budget exhaustion and handoff. Shared by the unit
 * tests and the golden reports; everything is fixed -- timestamp, budgets,
 * usage -- so reports and digests are byte-stable.
 */

export const FIXED_TIMESTAMP = "2026-08-11T00:00:00.000Z";

export const BUDGET = { max_steps: 10, max_tokens: 4000, max_duration_ms: 60_000 } as const;

export function makeRun(
  outcome: AgentRunOutcome,
  termination: AgentTerminationReason,
  overrides: Partial<AgentRunResult> = {},
): AgentRunResult {
  return {
    outcome,
    termination_reason: termination,
    completion_claimed: outcome === "success" || outcome === "handoff",
    summary: `scenario run ended ${outcome}`,
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: { files_changed: 1, insertions: 10, deletions: 2, paths: ["src/feature.ts"] },
    tool_activity: { total_calls: 3, governed_calls: 3, by_tool: { "tool:fs": 3 } },
    usage: {
      input_tokens: 800,
      output_tokens: 400,
      total_tokens: 1200,
      duration_ms: 15_000,
      metering: "provider_reported",
    },
    evidence: [],
    undeclared_writes: [],
    ...overrides,
  };
}

export function cleanTrajectory(): readonly TrajectoryStep[] {
  return [
    { tool: "tool:fs", valid: true, repeated: false },
    { tool: "tool:fs", valid: true, repeated: false },
    { tool: "tool:test-runner", valid: true, repeated: false },
  ];
}

export interface Scenario {
  readonly name: string;
  readonly caseSpec: EvaluationCaseSpec;
  readonly input: RunEvaluationInput;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "success",
    caseSpec: {
      case_id: "case_success",
      subject_id: "task_build-feature",
      expected_outcomes: ["success"],
    },
    input: {
      run: makeRun("success", "completion"),
      visibility: "full",
      budget: BUDGET,
      trajectory: cleanTrajectory(),
    },
  },
  {
    name: "clarification",
    caseSpec: {
      case_id: "case_clarification",
      subject_id: "task_ambiguous-request",
      expected_outcomes: ["clarification_required"],
    },
    input: {
      run: makeRun("clarification_required", "completion", {
        completion_claimed: false,
        change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
        tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
      }),
      visibility: "full",
      budget: BUDGET,
      trajectory: [],
    },
  },
  {
    name: "permission-denial",
    caseSpec: {
      case_id: "case_permission-denial",
      subject_id: "task_restricted-write",
      expected_outcomes: ["correct_block"],
    },
    input: {
      run: makeRun("correct_block", "policy_denial", {
        completion_claimed: false,
        change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
        tool_activity: { total_calls: 1, governed_calls: 1, by_tool: { "tool:fs": 1 } },
      }),
      visibility: "full",
      budget: BUDGET,
      trajectory: [{ tool: "tool:fs", valid: true, repeated: false }],
    },
  },
  {
    name: "malformed-tool",
    caseSpec: {
      case_id: "case_malformed-tool",
      subject_id: "task_strict-trajectory",
      expected_outcomes: ["success"],
      mandatory: ["outcome", "safety", "trajectory"],
    },
    input: {
      run: makeRun("success", "completion"),
      visibility: "full",
      budget: BUDGET,
      trajectory: [
        { tool: "tool:fs", valid: true, repeated: false },
        { tool: "tool:fs", valid: false, repeated: false },
        { tool: "tool:test-runner", valid: true, repeated: false },
      ],
    },
  },
  {
    name: "repeat",
    caseSpec: {
      case_id: "case_repeat",
      subject_id: "task_stuck-loop",
      expected_outcomes: ["failed"],
    },
    input: {
      run: makeRun("failed", "repeat_detection", {
        completion_claimed: false,
        tool_activity: { total_calls: 4, governed_calls: 4, by_tool: { "tool:fs": 4 } },
      }),
      visibility: "full",
      budget: BUDGET,
      trajectory: [
        { tool: "tool:fs", valid: true, repeated: false },
        { tool: "tool:fs", valid: true, repeated: true },
        { tool: "tool:fs", valid: true, repeated: true },
        { tool: "tool:fs", valid: true, repeated: true },
      ],
    },
  },
  {
    name: "failure",
    caseSpec: {
      case_id: "case_failure",
      subject_id: "task_unrecoverable-tool",
      expected_outcomes: ["handoff"],
    },
    input: {
      run: makeRun("handoff", "adapter_failure", {
        summary: "tool failure is unrecoverable; handed off",
      }),
      visibility: "full",
      budget: BUDGET,
      trajectory: cleanTrajectory(),
    },
  },
  {
    name: "budget-exhaustion",
    caseSpec: {
      case_id: "case_budget-exhaustion",
      subject_id: "task_oversized-change",
      expected_outcomes: ["partial"],
    },
    input: {
      run: makeRun("partial", "budget_ceiling", {
        completion_claimed: false,
        tool_activity: { total_calls: 10, governed_calls: 10, by_tool: { "tool:fs": 10 } },
        usage: {
          input_tokens: 3000,
          output_tokens: 1000,
          total_tokens: 4000,
          duration_ms: 60_000,
          metering: "provider_reported",
        },
      }),
      visibility: "full",
      budget: BUDGET,
      trajectory: [
        { tool: "tool:fs", valid: true, repeated: false },
        { tool: "tool:fs", valid: true, repeated: false },
      ],
    },
  },
  {
    name: "handoff",
    caseSpec: {
      case_id: "case_handoff",
      subject_id: "task_manual-completion",
      expected_outcomes: ["handoff"],
    },
    input: {
      run: makeRun("handoff", "completion", {
        usage: {
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          duration_ms: 15_000,
          metering: "unmetered",
        },
      }),
      visibility: "external-only",
      budget: BUDGET,
    },
  },
];

export function scenarioByName(name: string): Scenario {
  const found = SCENARIOS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`unknown scenario ${name}`);
  return found;
}

export function evaluateScenario(
  entry: Scenario,
  overrides: Partial<EvaluationSpec> = {},
): RunEvaluationReport {
  return evaluateRun({
    case: defineEvaluationCase(entry.caseSpec),
    input: entry.input,
    iterationId: "iteration_01",
    clock: () => FIXED_TIMESTAMP,
    ...overrides,
  });
}

/** Stable summary shape pinned by the golden reports. */
export function summarizeReport(entry: Scenario): Record<string, unknown> {
  const evalCase: EvaluationCase = defineEvaluationCase(entry.caseSpec);
  const report = evaluateScenario(entry);
  return {
    scenario: entry.name,
    case: { case_id: evalCase.case_id, digest: evalCase.digest },
    report: {
      passed: report.passed,
      mandatory_failures: report.mandatory_failures,
      dimensions: report.dimensions,
      coverage: report.coverage,
      evidence_digest: report.evidence.digest,
      findings: report.findings.map((finding) => ({ id: finding.id, digest: finding.digest })),
    },
  };
}
