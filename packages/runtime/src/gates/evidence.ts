import { PROTOCOL_VERSION, contentDigest, validateSchema } from "@universal-harness-internal/core";

import { GateError, type GateOutcome } from "./provider.js";

/**
 * Gate evidence records (design 15.3). Every gate outcome is persisted as an
 * append-only Evidence record whose digest binds exactly what was observed,
 * and whose extension binds every input the verdict depends on: the
 * applicable artifact and code digests, the ContextBundle, the gate
 * definition itself, the applicable EvaluationCases and the effective Policy.
 * Any change to a bound input must invalidate the evidence; the freshness
 * module performs that check against current authoritative digests.
 *
 * Evidence content is already redacted by the tool invocation pipeline: raw
 * logs never enter the record, only the normalized summary and hashes.
 */
export const GATE_EVIDENCE_EXTENSION_KEY = "harness.gate";

export const GATE_EVIDENCE_TYPE = "gate_result" as const;

/**
 * Every digest the verdict depends on (design 15.3). Array bindings compare
 * as sets; `context_bundle_digest` is bound only when the gate ran against a
 * compiled bundle.
 */
export interface EvidenceBindings {
  readonly artifact_digests: readonly string[];
  readonly code_digests: readonly string[];
  readonly context_bundle_digest?: string;
  readonly gate_digest: string;
  readonly evaluation_case_digests: readonly string[];
  readonly policy_digest: string;
}

/** Matches `EvidenceRecordSchema` in core; validated on build. */
export interface GateEvidenceRecord {
  readonly protocol_version: string;
  readonly record_kind: "evidence";
  readonly evidence_id: string;
  readonly evidence_type: string;
  readonly subject_id: string;
  readonly digest: string;
  readonly provisional: boolean;
  readonly created_at: string;
  readonly extensions?: Record<string, unknown>;
}

export interface GateEvidenceSpec {
  readonly evidenceId: string;
  readonly createdAt: string;
  /**
   * Provisional evidence comes from an atomic call that outlived stale
   * inputs (design 10.3); it can never close a Finding or satisfy a Snapshot.
   */
  readonly provisional?: boolean;
  readonly outcome: GateOutcome;
  readonly bindings: EvidenceBindings;
}

export interface GateEvidenceExtension {
  readonly gate_id: string;
  readonly layer: string;
  readonly mandatory: boolean;
  readonly passed: boolean;
  readonly exit_code: number | null;
  readonly summary: string;
  readonly log_summary: string;
  readonly artifact_hashes: Readonly<Record<string, string>>;
  readonly bindings: {
    readonly artifact_digests: readonly string[];
    readonly code_digests: readonly string[];
    readonly context_bundle_digest?: string;
    readonly gate_digest: string;
    readonly evaluation_case_digests: readonly string[];
    readonly policy_digest: string;
  };
}

function extensionOf(outcome: GateOutcome, bindings: EvidenceBindings): GateEvidenceExtension {
  return {
    gate_id: outcome.gate_id,
    layer: outcome.layer,
    mandatory: outcome.mandatory,
    passed: outcome.passed,
    exit_code: outcome.exit_code,
    summary: outcome.summary,
    log_summary: outcome.log_summary,
    artifact_hashes: outcome.artifact_hashes,
    bindings: {
      artifact_digests: [...bindings.artifact_digests].sort(),
      code_digests: [...bindings.code_digests].sort(),
      ...(bindings.context_bundle_digest === undefined
        ? {}
        : { context_bundle_digest: bindings.context_bundle_digest }),
      gate_digest: bindings.gate_digest,
      evaluation_case_digests: [...bindings.evaluation_case_digests].sort(),
      policy_digest: bindings.policy_digest,
    },
  };
}

/**
 * Build a schema-valid evidence record for one gate outcome. The record
 * digest covers the normalized outcome plus every binding, so two runs agree
 * on the digest exactly when they observed the same result against the same
 * inputs.
 */
export function buildGateEvidence(spec: GateEvidenceSpec): GateEvidenceRecord {
  const record: GateEvidenceRecord = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "evidence",
    evidence_id: spec.evidenceId,
    evidence_type: GATE_EVIDENCE_TYPE,
    subject_id: spec.outcome.subject_id,
    digest: contentDigest({
      evidence_type: GATE_EVIDENCE_TYPE,
      subject_id: spec.outcome.subject_id,
      outcome: {
        gate_id: spec.outcome.gate_id,
        layer: spec.outcome.layer,
        mandatory: spec.outcome.mandatory,
        passed: spec.outcome.passed,
        exit_code: spec.outcome.exit_code,
        summary: spec.outcome.summary,
        log_summary: spec.outcome.log_summary,
        artifact_hashes: spec.outcome.artifact_hashes,
        output_digest: spec.outcome.output_digest,
      },
      bindings: extensionOf(spec.outcome, spec.bindings).bindings,
    }),
    provisional: spec.provisional === true,
    created_at: spec.createdAt,
    extensions: {
      [GATE_EVIDENCE_EXTENSION_KEY]: extensionOf(spec.outcome, spec.bindings),
    },
  };
  const validation = validateSchema("runtime", record);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new GateError("invalid_evidence_record", `invalid gate evidence record: ${detail}`);
  }
  return record;
}

/** The gate extension payload of an evidence record, or undefined when absent. */
export function readGateEvidenceExtension(
  record: GateEvidenceRecord,
): GateEvidenceExtension | undefined {
  const extension = record.extensions?.[GATE_EVIDENCE_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) return undefined;
  return extension as GateEvidenceExtension;
}

/** Bindings an evidence record was produced against; undefined when absent. */
export function evidenceBindingsOf(record: GateEvidenceRecord): EvidenceBindings | undefined {
  return readGateEvidenceExtension(record)?.bindings;
}
