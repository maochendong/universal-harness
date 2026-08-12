/**
 * Typed Acceptance Evidence reporting hook (M1 plan, delivery discipline).
 *
 * Every acceptance criterion of the M1 design (28 items) must eventually be
 * backed by executed evidence: a test, golden dataset or E2E run whose
 * artifacts prove the criterion. This module defines the typed record and
 * the reporter port so later tasks can emit evidence without reshaping call
 * sites; the default collector is in-memory and deterministic, and no record
 * is ever silently dropped or rewritten.
 */
export type AcceptanceCriterionId = `AC-${number}`;

export type AcceptanceEvidenceStatus = "passed" | "failed" | "blocked" | "not_run";

export interface AcceptanceEvidenceRecord {
  /** Acceptance criterion, for example "AC-03". */
  readonly criterion_id: AcceptanceCriterionId;
  readonly status: AcceptanceEvidenceStatus;
  /**
   * Proof pointers: test file paths, golden artifact paths or content
   * digests. Empty only for "not_run".
   */
  readonly evidence: readonly string[];
  /** ISO 8601 timestamp; injectable so reports stay deterministic in tests. */
  readonly recorded_at: string;
  readonly detail?: string;
}

/** Sink for acceptance evidence; later tasks wire reporting destinations. */
export interface AcceptanceEvidenceReporter {
  report(record: AcceptanceEvidenceRecord): void;
}

export class AcceptanceEvidenceError extends Error {
  readonly kind = "acceptance_evidence_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "AcceptanceEvidenceError";
  }
}

const CRITERION_PATTERN = /^AC-([1-9]|[12][0-8])$/u;

export function assertAcceptanceEvidenceRecord(record: AcceptanceEvidenceRecord): void {
  if (!CRITERION_PATTERN.test(record.criterion_id)) {
    throw new AcceptanceEvidenceError(
      `invalid acceptance criterion id: ${JSON.stringify(record.criterion_id)}`,
    );
  }
  if (record.status !== "not_run" && record.evidence.length === 0) {
    throw new AcceptanceEvidenceError(
      `evidence record ${record.criterion_id} has status ${record.status} but no evidence pointers`,
    );
  }
}

export interface AcceptanceEvidenceCollector extends AcceptanceEvidenceReporter {
  /** Records in emission order; deterministic for a fixed input sequence. */
  records(): readonly AcceptanceEvidenceRecord[];
}

/**
 * In-memory reporter used until the reporting pipeline lands. Validates
 * every record on emission so malformed evidence fails at the source.
 */
export function createAcceptanceEvidenceCollector(): AcceptanceEvidenceCollector {
  const collected: AcceptanceEvidenceRecord[] = [];
  return {
    report(record) {
      assertAcceptanceEvidenceRecord(record);
      collected.push(record);
    },
    records() {
      return [...collected];
    },
  };
}
