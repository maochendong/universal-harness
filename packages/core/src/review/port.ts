import type { CaptureSessionRecord } from "../schema/capture.js";
import type { ProjectContextBundleRecord } from "../schema/context.js";
import type { PrdProposalRecord, PrdValidationReportRecord } from "../schema/proposal.js";
import type { ManualReviewInputRecord, PrdReviewReportDraft } from "../schema/review.js";
import type { PrdPortFailure } from "../proposal/port.js";

/**
 * PrdReviewPort contract (intent-to-prd design 10). The reviewer owns only the
 * assessment: it receives already-committed facts (current proposal, the
 * review-purpose context bundle, the passed validation report, the rubric and
 * an optional manual rubric input) and returns a report draft, a manual-input
 * request or a typed failure. It can never mint canonical ids, approve, or
 * choose the next state — the Coordinator owns validity, routing and
 * transitions.
 */

/** The versioned rubric the review is assessed against (design 10.1). */
export interface PrdReviewRubricDimension {
  readonly dimension_id: string;
  readonly prompt: string;
}

export interface PrdReviewRubric {
  readonly rubric_id: string;
  readonly dimensions: readonly PrdReviewRubricDimension[];
  readonly mandatory_dimension_ids: readonly string[];
}

/** Identity fields every Capture review profile variant carries (design 10.1). */
export interface CaptureReviewProfileBase {
  readonly adapter_profile_digest: string;
  readonly prompt_version_digest: string;
  readonly reviewer_identity: string;
}

/**
 * The model-backed variant: it pins the resolved Prompt Contract identity and
 * the output schema digest in addition to the legacy digests. The contract
 * fields are derived from the PromptContractRegistry — never hand-filled.
 */
export interface ModelBackedCaptureReviewProfile extends CaptureReviewProfileBase {
  readonly backing: "model";
  readonly prompt_version: string;
  readonly prompt_contract_id: string;
  readonly prompt_contract_version: string;
  readonly prompt_contract_digest: string;
  readonly output_schema_digest: string;
}

/** The manual variant: digest-only, zero prompt compilation. */
export interface ManualCaptureReviewProfile extends CaptureReviewProfileBase {
  readonly backing: "manual";
}

/** The in-memory (test double) variant: digest-only, zero prompt compilation. */
export interface InMemoryCaptureReviewProfile extends CaptureReviewProfileBase {
  readonly backing: "in_memory";
}

/**
 * Adapter identity and prompt versioning for the review slot (design 10.1,
 * prompt governance addendum 5.2): a discriminated union over the Capture
 * adapter backings; only the model-backed variant binds a contract.
 */
export type CaptureReviewProfile =
  ModelBackedCaptureReviewProfile | ManualCaptureReviewProfile | InMemoryCaptureReviewProfile;

/** The committed invocation the review call runs under (design 10.1, 11.3). */
export interface CaptureReviewInvocationBinding {
  readonly invocation_id: string;
  readonly conversation_id: string;
  readonly evidence_locator: string;
}

/** A rubric prompt the manual review UX must collect an input for. */
export interface ManualReviewQuestion {
  readonly dimension_id: string;
  readonly prompt: string;
}

export interface PrdReviewInput {
  readonly session: CaptureSessionRecord;
  readonly proposal: PrdProposalRecord;
  readonly review_context_bundle: ProjectContextBundleRecord;
  readonly validation_report: PrdValidationReportRecord;
  readonly manual_input?: ManualReviewInputRecord;
  readonly rubric: PrdReviewRubric;
  readonly profile: CaptureReviewProfile;
  readonly invocation: CaptureReviewInvocationBinding;
}

export type PrdReviewResult =
  | { readonly status: "completed"; readonly report: PrdReviewReportDraft }
  | {
      readonly status: "input_required";
      readonly questions: readonly ManualReviewQuestion[];
    }
  | { readonly status: "failed"; readonly failure: PrdPortFailure };

export interface PrdReviewPort {
  readonly name: string;
  review(input: PrdReviewInput): Promise<PrdReviewResult> | PrdReviewResult;
}
