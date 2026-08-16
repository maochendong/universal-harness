import { PROTOCOL_VERSION, contentDigest, validateSchema } from "@universal-harness-internal/core";

import type { TaskAcceptanceAssertion } from "../planning/task.js";

export interface TaskVerdictAssertion {
  readonly assertion_id: string;
  readonly passed: boolean;
  readonly test_ids: readonly string[];
  readonly evidence_ids: readonly string[];
}

export interface TaskVerdictRecord {
  readonly protocol_version: string;
  readonly record_kind: "task_verdict";
  readonly verdict_id: string;
  readonly iteration_id: string;
  readonly task_id: string;
  readonly run_ids: readonly string[];
  readonly verdict: "passed" | "failed" | "blocked";
  readonly assertion_verdicts: readonly TaskVerdictAssertion[];
  readonly gate_evidence_ids: readonly string[];
  readonly evaluation_evidence_ids: readonly string[];
  readonly created_at: string;
  readonly digest: string;
  readonly extensions?: Record<string, unknown>;
}

export interface TaskVerdictEvidenceInput {
  readonly passed: boolean;
  readonly evidence_id: string;
}

export interface TaskVerdictGateInput extends TaskVerdictEvidenceInput {
  readonly gate_id: string;
}

export interface BuildTaskVerdictInput {
  readonly verdictId: string;
  readonly iterationId: string;
  readonly taskId: string;
  readonly runIds: readonly string[];
  readonly assertions: readonly TaskAcceptanceAssertion[];
  readonly gates: readonly TaskVerdictGateInput[];
  readonly evaluations: readonly TaskVerdictEvidenceInput[];
  readonly createdAt: string;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Build the immutable acceptance verdict from current machine-checkable proof. */
export function buildTaskVerdict(input: BuildTaskVerdictInput): TaskVerdictRecord {
  const gateById = new Map(input.gates.map((gate) => [gate.gate_id, gate]));
  const evaluationsPass =
    input.evaluations.length > 0 && input.evaluations.every((evaluation) => evaluation.passed);
  const assertionVerdicts = [...input.assertions]
    .sort((left, right) => left.assertion_id.localeCompare(right.assertion_id))
    .map((assertion): TaskVerdictAssertion => {
      const requiredGates = assertion.required_gate_ids.map((gateId) => gateById.get(gateId));
      const gatesPass =
        requiredGates.length === assertion.required_gate_ids.length &&
        requiredGates.every((gate) => gate?.passed === true);
      const evidenceIds = uniqueSorted([
        ...requiredGates.flatMap((gate) => (gate === undefined ? [] : [gate.evidence_id])),
        ...input.evaluations.map((evaluation) => evaluation.evidence_id),
      ]);
      const requirementsSatisfied = assertion.evidence_requirements.every((requirement) => {
        if (requirement === "gate_evidence") return requiredGates.length > 0;
        if (requirement === "evaluation_evidence") return input.evaluations.length > 0;
        return evidenceIds.length > 0;
      });
      return {
        assertion_id: assertion.assertion_id,
        passed:
          assertion.test_ids.length > 0 &&
          gatesPass &&
          evaluationsPass &&
          requirementsSatisfied &&
          evidenceIds.length > 0,
        test_ids: uniqueSorted(assertion.test_ids),
        evidence_ids: evidenceIds,
      };
    });
  const passed = assertionVerdicts.length > 0 && assertionVerdicts.every((entry) => entry.passed);
  const content = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "task_verdict" as const,
    verdict_id: input.verdictId,
    iteration_id: input.iterationId,
    task_id: input.taskId,
    run_ids: uniqueSorted(input.runIds),
    verdict: passed ? ("passed" as const) : ("failed" as const),
    assertion_verdicts: assertionVerdicts,
    gate_evidence_ids: uniqueSorted(input.gates.map((gate) => gate.evidence_id)),
    evaluation_evidence_ids: uniqueSorted(
      input.evaluations.map((evaluation) => evaluation.evidence_id),
    ),
    created_at: input.createdAt,
  };
  const record = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("runtime", record);
  if (!validation.valid) {
    throw new Error(
      `invalid TaskVerdict: ${validation.errors
        .map((issue) => `${issue.instancePath}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return record;
}
