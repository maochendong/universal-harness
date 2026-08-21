import {
  sealRecordEnvelope,
  contentDigest,
  type FailureOracle,
  type TddCycleRecord,
  type TddEvidenceBinding,
  type TddPathPolicy,
} from "@universal-harness-internal/core";

import { attestWriteSet, canonicalTestPatch, validateTestAuthoringPatch } from "./patch.js";
import type { PatchFile } from "./patch.js";

/**
 * The TddController evidence core (provable TDD design 8-10, plan T16): a
 * pure state machine over accepted ledger facts. RedEvidence forms only
 * from the bound baseline, the frozen patch, the contract gate, framework
 * and environment, and a structured failure that hits a target assertion
 * and matches the Failure Oracle; GreenEvidence must reuse the exact same
 * patch, gate, selectors, framework and environment. Syntax errors,
 * timeouts, missing results, agent self-reports and transcripts never form
 * evidence — anything unstructured or drifting fails closed.
 */
export const TDD_CYCLE_STATES = [
  "contract_ready",
  "baseline_guard",
  "test_authoring",
  "red_verification",
  "implementation",
  "green_verification",
  "refactor",
  "cycle_completed",
  "blocked",
  "invalidated",
  "budget_exhausted",
  "cancelled",
] as const;
export type TddCycleState = (typeof TDD_CYCLE_STATES)[number];

export type StructuredTestResult =
  | {
      readonly outcome: "structured";
      readonly runs: readonly {
        readonly selector_id: string;
        readonly status: "passed" | "failed";
        readonly assertion_id?: string;
        readonly failure_kind?: string;
        readonly error_code?: string;
        readonly symbols?: readonly string[];
        readonly message?: string;
      }[];
    }
  | {
      readonly outcome: "syntax_error" | "environment_error" | "timeout" | "oom" | "missing_result";
    };

export interface TddCycleView {
  readonly state: TddCycleState;
  readonly logical_cycle_id: string;
  readonly attempt_ordinal: number;
  readonly task_id: string;
  readonly assertion_ids: readonly string[];
  readonly contract_digest: string;
  readonly repository_baseline: string;
  readonly baseline_evidence?: TddEvidenceBinding;
  readonly test_patch_digest?: string;
  readonly red_evidence?: TddEvidenceBinding;
  readonly green_evidence?: TddEvidenceBinding;
  readonly implementation_revision?: string;
  readonly block_reason?: string;
}

export const TDD_EVIDENCE_ISSUE_CODES = [
  "baseline_unhealthy",
  "patch_drift",
  "write_set_violation",
  "binding_drift",
  "unstructured_result",
  "no_target_assertion",
  "oracle_mismatch",
  "selector_missing",
  "state_order",
] as const;
export type TddEvidenceIssueCode = (typeof TDD_EVIDENCE_ISSUE_CODES)[number];

export interface TddEvidenceIssue {
  readonly code: TddEvidenceIssueCode;
  readonly message: string;
}

function issue(code: TddEvidenceIssueCode, message: string): TddEvidenceIssue {
  return { code, message };
}

export function createTddCycle(input: {
  readonly task_id: string;
  readonly assertion_ids: readonly string[];
  readonly contract_digest: string;
  readonly repository_baseline: string;
  readonly logical_cycle_id?: string;
  readonly attempt_ordinal?: number;
}): TddCycleView {
  return {
    state: "baseline_guard",
    logical_cycle_id:
      input.logical_cycle_id ??
      `cycle_${contentDigest({ task: input.task_id, contract: input.contract_digest }).slice(0, 16)}`,
    attempt_ordinal: input.attempt_ordinal ?? 1,
    task_id: input.task_id,
    assertion_ids: input.assertion_ids,
    contract_digest: input.contract_digest,
    repository_baseline: input.repository_baseline,
  };
}

interface EvidenceInput {
  readonly target_gate_binding_digest: string;
  readonly framework_profile_digest: string;
  readonly executor_environment_digest: string;
  readonly grant_digest: string;
  readonly observed_write_set_digest: string;
  readonly output_artifact: { readonly locator: string; readonly digest: string };
}

function binding(
  evidenceType: TddEvidenceBinding["evidence_type"],
  view: TddCycleView,
  input: EvidenceInput,
  extra: {
    readonly test_patch_digest?: string;
    readonly selector_ids?: readonly string[];
    readonly failure_kind?: string;
  } = {},
): TddEvidenceBinding {
  return {
    evidence_type: evidenceType,
    task_id: view.task_id,
    logical_cycle_id: view.logical_cycle_id,
    attempt_ordinal: view.attempt_ordinal,
    contract_digest: view.contract_digest,
    repository_baseline: view.repository_baseline,
    ...(extra.test_patch_digest === undefined
      ? {}
      : { test_patch_digest: extra.test_patch_digest }),
    target_gate_binding_digest: input.target_gate_binding_digest,
    framework_profile_digest: input.framework_profile_digest,
    executor_environment_digest: input.executor_environment_digest,
    selector_ids: [...(extra.selector_ids ?? [])],
    assertion_ids: [...view.assertion_ids],
    ...(extra.failure_kind === undefined ? {} : { failure_kind: extra.failure_kind }),
    grant_digest: input.grant_digest,
    observed_write_set_digest: input.observed_write_set_digest,
    output_artifact: input.output_artifact,
  };
}

function evidenceDigest(evidence: TddEvidenceBinding): string {
  return contentDigest(evidence);
}

export function acceptBaselineEvidence(
  view: TddCycleView,
  input: EvidenceInput & { readonly gate_passed: boolean },
): { readonly next: TddCycleView; readonly issues: readonly TddEvidenceIssue[] } {
  if (view.state !== "baseline_guard") {
    return {
      next: view,
      issues: [issue("state_order", `baseline evidence in state ${view.state}`)],
    };
  }
  if (!input.gate_passed) {
    const next: TddCycleView = {
      ...view,
      state: "blocked",
      block_reason: "pre_existing_failure: baseline gate failed before any change",
      baseline_evidence: binding("baseline_test_result", view, input),
    };
    return { next, issues: [] };
  }
  return {
    next: {
      ...view,
      state: "test_authoring",
      baseline_evidence: binding("baseline_test_result", view, input),
    },
    issues: [],
  };
}

export function freezeTestPatch(
  view: TddCycleView,
  files: readonly PatchFile[],
  policy: TddPathPolicy,
): {
  readonly next: TddCycleView;
  readonly patch_digest: string;
  readonly issues: readonly TddEvidenceIssue[];
} {
  if (view.state !== "test_authoring") {
    return {
      next: view,
      patch_digest: "",
      issues: [issue("state_order", `test patch freeze in state ${view.state}`)],
    };
  }
  const patchIssues = validateTestAuthoringPatch(files, policy);
  const patch = canonicalTestPatch(files);
  if (patchIssues.length > 0) {
    return {
      next: view,
      patch_digest: patch.patch_digest,
      issues: patchIssues.map((entry) => issue("write_set_violation", entry.message)),
    };
  }
  return {
    next: { ...view, state: "red_verification", test_patch_digest: patch.patch_digest },
    patch_digest: patch.patch_digest,
    issues: [],
  };
}

/** Restricted oracle matching: sets and plain substrings, never regexes. */
export function matchFailureOracle(
  failure: {
    readonly failure_kind?: string;
    readonly assertion_id?: string;
    readonly error_code?: string;
    readonly symbols?: readonly string[];
    readonly message?: string;
  },
  oracle: FailureOracle,
): boolean {
  if (
    failure.failure_kind === undefined ||
    !oracle.allowed_failure_kinds.includes(failure.failure_kind as never)
  ) {
    return false;
  }
  if (
    oracle.expected_error_codes !== undefined &&
    (failure.error_code === undefined || !oracle.expected_error_codes.includes(failure.error_code))
  ) {
    return false;
  }
  if (
    oracle.expected_symbols !== undefined &&
    (failure.symbols === undefined ||
      !failure.symbols.every((symbol) => oracle.expected_symbols?.includes(symbol)))
  ) {
    return false;
  }
  if (
    oracle.normalized_message_patterns !== undefined &&
    (failure.message === undefined ||
      !oracle.normalized_message_patterns.some((pattern) => failure.message?.includes(pattern)))
  ) {
    return false;
  }
  return true;
}

interface VerificationInput extends EvidenceInput {
  readonly test_patch_digest: string;
  readonly oracle: FailureOracle;
  readonly result: StructuredTestResult;
}

function bindingDigestChecks(view: TddCycleView, input: VerificationInput): TddEvidenceIssue[] {
  const issues: TddEvidenceIssue[] = [];
  if (input.test_patch_digest !== view.test_patch_digest) {
    issues.push(issue("patch_drift", "test patch digest drifted from the frozen patch"));
  }
  const baseline = view.baseline_evidence;
  if (baseline !== undefined) {
    if (input.target_gate_binding_digest !== baseline.target_gate_binding_digest) {
      issues.push(issue("binding_drift", "target gate binding drifted from baseline evidence"));
    }
    if (input.framework_profile_digest !== baseline.framework_profile_digest) {
      issues.push(issue("binding_drift", "framework profile drifted from baseline evidence"));
    }
    if (input.executor_environment_digest !== baseline.executor_environment_digest) {
      issues.push(issue("binding_drift", "executor environment drifted from baseline evidence"));
    }
  }
  return issues;
}

export function acceptRedEvidence(
  view: TddCycleView,
  input: VerificationInput,
): { readonly next: TddCycleView; readonly issues: readonly TddEvidenceIssue[] } {
  if (view.state !== "red_verification" || view.baseline_evidence === undefined) {
    return { next: view, issues: [issue("state_order", `red evidence in state ${view.state}`)] };
  }
  const issues = bindingDigestChecks(view, input);
  if (input.result.outcome !== "structured") {
    issues.push(
      issue(
        "unstructured_result",
        `red evidence outcome ${input.result.outcome} can never prove a failure`,
      ),
    );
    return { next: view, issues };
  }
  const failedRuns = input.result.runs.filter((run) => run.status === "failed");
  const targetHits = failedRuns.filter(
    (run) => run.assertion_id !== undefined && view.assertion_ids.includes(run.assertion_id),
  );
  if (targetHits.length === 0) {
    issues.push(issue("no_target_assertion", "no structured failure hits a target assertion"));
  }
  for (const run of targetHits) {
    if (!matchFailureOracle(run, input.oracle)) {
      issues.push(
        issue("oracle_mismatch", `failure of ${run.selector_id} does not match the failure oracle`),
      );
    }
  }
  if (issues.length > 0) return { next: view, issues };
  const evidence = binding("red_test_result", view, input, {
    test_patch_digest: input.test_patch_digest,
    selector_ids: input.result.runs.map((run) => run.selector_id),
    ...(targetHits[0]?.failure_kind === undefined
      ? {}
      : { failure_kind: targetHits[0].failure_kind }),
  });
  return {
    next: { ...view, state: "implementation", red_evidence: evidence },
    issues: [],
  };
}

export function acceptGreenEvidence(
  view: TddCycleView,
  input: VerificationInput & {
    readonly production_write_set: readonly string[];
    readonly implementation_write_scopes: readonly string[];
    readonly implementation_revision: string;
  },
): { readonly next: TddCycleView; readonly issues: readonly TddEvidenceIssue[] } {
  if (view.state !== "implementation" || view.red_evidence === undefined) {
    return { next: view, issues: [issue("state_order", `green evidence in state ${view.state}`)] };
  }
  const issues = bindingDigestChecks(view, input);
  const violations = attestWriteSet(input.production_write_set, input.implementation_write_scopes);
  if (violations.length > 0) {
    issues.push(
      issue("write_set_violation", `production writes outside the grant: ${violations.join(", ")}`),
    );
  }
  if (input.result.outcome !== "structured") {
    issues.push(
      issue("unstructured_result", `green evidence outcome ${input.result.outcome} proves nothing`),
    );
    return { next: view, issues };
  }
  const oracleSelectors = new Set(input.oracle.selector_ids);
  const seen = new Set(
    input.result.runs.filter((run) => run.status === "passed").map((run) => run.selector_id),
  );
  for (const selector of oracleSelectors) {
    if (!seen.has(selector)) {
      issues.push(issue("selector_missing", `target selector ${selector} did not pass`));
    }
  }
  if (input.result.runs.some((run) => run.status === "failed")) {
    issues.push(issue("oracle_mismatch", "green evidence still carries failing runs"));
  }
  if (issues.length > 0) return { next: view, issues };
  const evidence = binding("green_test_result", view, input, {
    test_patch_digest: input.test_patch_digest,
    selector_ids: input.result.runs.map((run) => run.selector_id),
  });
  return {
    next: {
      ...view,
      state: "cycle_completed",
      green_evidence: evidence,
      implementation_revision: input.implementation_revision,
    },
    issues: [],
  };
}

/** Seal the immutable per-attempt record (design 9.4 field completeness). */
export function buildTddCycleRecord(view: TddCycleView): TddCycleRecord {
  const status =
    view.state === "cycle_completed"
      ? "completed"
      : view.state === "blocked"
        ? "blocked"
        : "invalidated";
  const base: Record<string, unknown> = {
    protocol_version: "1.1.0",
    record_kind: "tdd_cycle",
    logical_cycle_id: view.logical_cycle_id,
    attempt_ordinal: view.attempt_ordinal,
    task_id: view.task_id,
    assertion_ids: view.assertion_ids,
    contract_digest: view.contract_digest,
    repository_baseline: view.repository_baseline,
    ...(view.baseline_evidence === undefined
      ? {}
      : { baseline_evidence_digest: evidenceDigest(view.baseline_evidence) }),
    ...(view.test_patch_digest === undefined ? {} : { test_patch_digest: view.test_patch_digest }),
    ...(view.baseline_evidence === undefined
      ? {}
      : {
          target_gate_binding_digest: view.baseline_evidence.target_gate_binding_digest,
          executor_environment_digest: view.baseline_evidence.executor_environment_digest,
        }),
    ...(view.red_evidence === undefined
      ? {}
      : { red_evidence_digest: evidenceDigest(view.red_evidence) }),
    ...(view.green_evidence === undefined
      ? {}
      : { green_evidence_digest: evidenceDigest(view.green_evidence) }),
    ...(view.implementation_revision === undefined
      ? {}
      : { implementation_revision: view.implementation_revision }),
    status,
    ...(status === "completed"
      ? {}
      : { reason: view.block_reason ?? `cycle ${status} in state ${view.state}` }),
  };
  return sealRecordEnvelope(base) as unknown as TddCycleRecord;
}
