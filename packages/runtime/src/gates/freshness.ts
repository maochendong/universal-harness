import type { Freshness } from "../context/compiler.js";
import {
  evidenceBindingsOf,
  readGateEvidenceExtension,
  type EvidenceBindings,
  type GateEvidenceRecord,
} from "./evidence.js";

/**
 * Evidence freshness (design 15.3 and completion rule 19/20). Evidence is
 * fresh only while every digest it binds still holds: the applicable artifact
 * and code sets, the ContextBundle, the gate definition, the applicable
 * EvaluationCases and the effective Policy. Any changed, added or removed
 * input makes the evidence stale, and stale evidence can never close a
 * Finding or satisfy a `completed` Snapshot -- only a fresh re-run can.
 */
export interface CurrentEvidenceState {
  /** Current content digests of the artifacts the evidence covered. */
  readonly artifact_digests: readonly string[];
  /** Current content digests of the code artifacts the evidence covered. */
  readonly code_digests: readonly string[];
  readonly context_bundle_digest?: string;
  /** Current digest of the gate definition that produced the evidence. */
  readonly gate_digest: string;
  readonly evaluation_case_digests: readonly string[];
  readonly policy_digest: string;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = new Set(right);
  return left.every((value) => remaining.delete(value));
}

function setReasons(
  label: string,
  bound: readonly string[],
  current: readonly string[],
): readonly string[] {
  if (sameSet(bound, current)) return [];
  return [`bound ${label} set changed`];
}

function scalarReason(
  label: string,
  bound: string | undefined,
  current: string | undefined,
): readonly string[] {
  if (bound === current) return [];
  return [`bound ${label} digest changed`];
}

/** Every reason the evidence no longer reflects current state; empty is fresh. */
export function bindingsStalenessReasons(
  bindings: EvidenceBindings,
  current: CurrentEvidenceState,
): readonly string[] {
  return [
    ...setReasons("artifact", bindings.artifact_digests, current.artifact_digests),
    ...setReasons("code", bindings.code_digests, current.code_digests),
    ...scalarReason(
      "context bundle",
      bindings.context_bundle_digest,
      current.context_bundle_digest,
    ),
    ...scalarReason("gate", bindings.gate_digest, current.gate_digest),
    ...setReasons(
      "evaluation case",
      bindings.evaluation_case_digests,
      current.evaluation_case_digests,
    ),
    ...scalarReason("policy", bindings.policy_digest, current.policy_digest),
  ];
}

/** Staleness reasons for one evidence record; records without bindings are stale. */
export function evidenceStalenessReasons(
  record: GateEvidenceRecord,
  current: CurrentEvidenceState,
): readonly string[] {
  const bindings = evidenceBindingsOf(record);
  if (bindings === undefined) {
    return ["evidence carries no gate bindings"];
  }
  return bindingsStalenessReasons(bindings, current);
}

export function isEvidenceStale(
  record: GateEvidenceRecord,
  current: CurrentEvidenceState,
): boolean {
  return evidenceStalenessReasons(record, current).length > 0;
}

export function evidenceFreshnessOf(
  record: GateEvidenceRecord,
  current: CurrentEvidenceState,
): Freshness {
  return isEvidenceStale(record, current) ? "stale" : "fresh";
}

/**
 * Whether this evidence may close a Finding (completion rule 19): only a
 * passed, non-provisional, currently fresh verdict counts. Stale evidence
 * never closes anything, no matter how green it once was.
 */
export function findingClosableBy(
  record: GateEvidenceRecord,
  current: CurrentEvidenceState,
): boolean {
  if (record.provisional) return false;
  const extension = readGateEvidenceExtension(record);
  if (extension === undefined || !extension.passed) return false;
  return !isEvidenceStale(record, current);
}
