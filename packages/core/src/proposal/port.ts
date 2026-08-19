import type { ClarificationQuestionDraft } from "../capture/records.js";
import type { CaptureSessionRecord, ClarificationAnswerRecord } from "../schema/capture.js";
import type { ProjectContextBundleRecord } from "../schema/context.js";
import type {
  PrdProposalDraft,
  PrdProposalRecord,
  PrdValidationReportRecord,
} from "../schema/proposal.js";

/**
 * PrdProposalPort contract (intent-to-prd design 9). The port owns only
 * generation: it receives already-committed facts and returns a draft, typed
 * clarification questions or a typed failure. It has no Session/Ledger write
 * access and can never return canonical ids, an accepted state, an approval
 * or a next state — the Coordinator owns validity, identity and transitions.
 */
export const PRD_PORT_FAILURE_CODES = [
  "invalid_output",
  "provider_unavailable",
  "timeout",
  "budget_exhausted",
  "version_mismatch",
  "uncertain",
  "policy_denied",
] as const;
export type PrdPortFailureCode = (typeof PRD_PORT_FAILURE_CODES)[number];

/** Unified port failure contract (design 11.4). */
export interface PrdPortFailure {
  readonly code: PrdPortFailureCode | "legacy_no_proposal";
  readonly retryable: boolean;
  /** Sanitized, safe to display; raw provider output stays in controlled Evidence. */
  readonly summary: string;
  readonly evidence_locator?: string;
  readonly raw_output_digest?: string;
}

/** Adapter identity and prompt versioning for the proposal slot (design 9.1). */
export interface CaptureProposalProfile {
  readonly adapter_profile_digest: string;
  readonly prompt_version_digest: string;
  readonly producer_identity: string;
}

/** The committed invocation the proposal call runs under (design 9.1, 11.3). */
export interface CaptureInvocationBinding {
  readonly invocation_id: string;
  readonly conversation_id: string;
  readonly evidence_locator: string;
}

export interface PrdProposalInput {
  readonly session: CaptureSessionRecord;
  readonly proposal_context_bundle: ProjectContextBundleRecord;
  readonly accepted_answers: readonly ClarificationAnswerRecord[];
  readonly previous_proposal?: PrdProposalRecord;
  readonly deterministic_feedback?: PrdValidationReportRecord;
  readonly profile: CaptureProposalProfile;
  readonly invocation: CaptureInvocationBinding;
}

export type PrdProposalResult =
  | { readonly status: "proposed"; readonly draft: PrdProposalDraft }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly ClarificationQuestionDraft[];
    }
  | { readonly status: "failed"; readonly failure: PrdPortFailure };

export interface PrdProposalPort {
  readonly name: string;
  propose(input: PrdProposalInput): Promise<PrdProposalResult> | PrdProposalResult;
}
