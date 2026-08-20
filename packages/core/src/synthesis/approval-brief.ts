import { contentDigest } from "../identity/digest.js";
import type { CaptureSessionRecord } from "../schema/capture.js";
import type { ProjectContextBundleRecord, ProjectContextSource } from "../schema/context.js";
import type { PrdProposalRecord, PrdValidationReportRecord } from "../schema/proposal.js";
import type { PrdReviewReportRecord } from "../schema/review.js";
import type { CaptureRiskAssessmentRecord } from "../schema/risk.js";
import type { CaptureModelProviderBindingRecord, ModelProviderBinding } from "../schema/profile.js";
import {
  GROUNDED_SYNTHESIS_SCHEMA_VERSIONS,
  type ApprovalBriefInput,
  type ApprovalBriefOutput,
  type GroundedSynthesisRecord,
} from "../schema/synthesis.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import { createProjectContextBundleRecord } from "../context/records.js";
import { appendProjectContextBundleRecord, readProjectContextBundles } from "../context/store.js";
import { readCaptureModelProviderBindings } from "../profile/store.js";
import { validateGroundedCitations } from "./citations.js";
import type {
  GroundedSynthesisFailure,
  GroundedSynthesisFailureCode,
  GroundedSynthesisPort,
} from "./port.js";
import {
  createGroundedSynthesisRecord,
  deriveGroundedConversationId,
  deriveGroundedRunId,
  SynthesisRecordError,
} from "./records.js";
import { appendGroundedSynthesisRecord, readGroundedSynthesisRecords } from "./store.js";

/**
 * The Capture `approval_brief` pipeline (unified plan T7, model advisory
 * design 10/11.1, intent-to-prd design 7.5). It runs after the approval object
 * is committed and before a human approval is presented, consumes only the
 * ProfileDecision-level Capture-scope binding committed by T2 (never the
 * CapabilityPlan), grounds every claim in the approval bundle and seals a
 * GroundedSynthesisRecord. The summary never enters the approved object's
 * semantic digest and — by schema — carries no verdict, risk level or scope
 * override.
 */
export interface ApprovalBriefFacts {
  readonly session: CaptureSessionRecord;
  readonly proposal: PrdProposalRecord;
  readonly validation_report: PrdValidationReportRecord;
  readonly review_report: PrdReviewReportRecord;
  readonly risk_assessment: CaptureRiskAssessmentRecord;
  /** Sources of the review-purpose bundle, reused for project grounding. */
  readonly review_bundle_sources: readonly ProjectContextSource[];
}

export type ApprovalBriefOutcome =
  | { readonly status: "completed"; readonly record: GroundedSynthesisRecord }
  | { readonly status: "blocked"; readonly failure: GroundedSynthesisFailure };

function blocked(
  code: GroundedSynthesisFailureCode,
  summary: string,
  retryable = false,
): ApprovalBriefOutcome {
  return { status: "blocked", failure: { code, summary, retryable } };
}

const APPROVAL_BRIEF_BUDGET = {
  max_files: 64,
  max_bytes_per_source: 65536,
  max_total_bytes: 1048576,
  max_summary_chars: 2000,
} as const;

/** Locator of the proposal source inside the approval bundle. */
export function approvalBriefProposalLocator(proposalContentDigest: string): string {
  return `capture://prd-proposal/${proposalContentDigest}`;
}

function approvalObjectSources(facts: ApprovalBriefFacts): ProjectContextSource[] {
  const objectSource = (
    locator: string,
    digest: string,
    summary: string,
  ): ProjectContextSource => ({
    locator,
    source_kind: "graph",
    source_digest: digest,
    selection_reason: "approval object binding",
    classification: "internal_project",
    summary,
    truncated: false,
  });
  return [
    objectSource(
      approvalBriefProposalLocator(facts.proposal.content_digest),
      facts.proposal.record_digest,
      `PRD proposal ${facts.proposal.proposal_id} under approval`,
    ),
    objectSource(
      `capture://prd-validation/${facts.validation_report.report_digest}`,
      facts.validation_report.record_digest,
      "Deterministic hard-gate validation report for the proposal",
    ),
    objectSource(
      `capture://prd-review/${facts.review_report.report_digest}`,
      facts.review_report.record_digest,
      `Independent review report (verdict ${facts.review_report.verdict})`,
    ),
    objectSource(
      `capture://capture-risk/${facts.risk_assessment.assessment_digest}`,
      facts.risk_assessment.record_digest,
      `Capture risk assessment (${facts.risk_assessment.level}/${facts.risk_assessment.materiality}/${facts.risk_assessment.confidence})`,
    ),
  ];
}

/**
 * Compile the approval bundle: the committed approval objects plus the
 * review-purpose project sources. Deterministic for the same committed facts,
 * so a retry re-seals the identical bundle.
 */
export function compileApprovalBriefBundle(facts: ApprovalBriefFacts): ProjectContextBundleRecord {
  return createProjectContextBundleRecord({
    session_id: facts.session.session_id,
    purpose: "approval_brief",
    project_baseline_digest: facts.session.project_baseline_digest,
    profile_digest: facts.session.project_profile_digest,
    policy_digest: facts.session.capture_policy_digest,
    budget: { ...APPROVAL_BRIEF_BUDGET },
    sources: [...approvalObjectSources(facts), ...facts.review_bundle_sources],
    exclusions: [],
  });
}

interface ResolvedBinding {
  readonly record: CaptureModelProviderBindingRecord;
  readonly binding: ModelProviderBinding;
}

/** Resolve the Capture-scope approval_brief binding (T2 records only). */
export function resolveApprovalBriefBinding(
  projectRoot: string,
  session: CaptureSessionRecord,
): ResolvedBinding | ApprovalBriefOutcome {
  const records = readCaptureModelProviderBindings(projectRoot).filter(
    (record) => record.profile_decision_digest === session.profile_decision_digest,
  );
  const matches: ResolvedBinding[] = records.flatMap((record) =>
    record.bindings
      .filter(
        (binding) =>
          binding.slot_id === "grounded_synthesis" && binding.purpose === "approval_brief",
      )
      .map((binding) => ({ record, binding })),
  );
  if (matches.length === 0) {
    return blocked(
      "provider_required",
      "no committed Capture-scope binding covers grounded_synthesis/approval_brief",
    );
  }
  const distinctRecords = new Set(matches.map((match) => match.record.record_digest));
  if (distinctRecords.size > 1) {
    return blocked("binding_drift", "conflicting Capture-scope binding records for approval_brief");
  }
  const resolved = matches[0]!;
  if (
    resolved.record.baseline_digest !== session.project_baseline_digest ||
    resolved.record.policy_digest !== session.capture_policy_digest
  ) {
    return blocked(
      "binding_drift",
      "the committed Capture-scope binding no longer matches the session baseline/policy",
    );
  }
  if (resolved.binding.schema_version !== GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.approval_brief) {
    return blocked(
      "version_mismatch",
      `binding schema version ${resolved.binding.schema_version} is not the registered ${GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.approval_brief}`,
    );
  }
  return resolved;
}

export interface RunApprovalBriefDeps {
  readonly projectRoot: string;
  readonly port: GroundedSynthesisPort;
  readonly facts: ApprovalBriefFacts;
  /** The approval request identity the brief is presented with. */
  readonly approval_request_id: string;
  /** Bounded controlled retries for retryable port failures (default 1). */
  readonly maxRetries?: number;
}

export async function runApprovalBrief(deps: RunApprovalBriefDeps): Promise<ApprovalBriefOutcome> {
  const { projectRoot, facts } = deps;

  const resolved = resolveApprovalBriefBinding(projectRoot, facts.session);
  if (!("binding" in resolved)) return resolved;
  const bindingRecordDigest = resolved.record.record_digest;

  const bundle = compileApprovalBriefBundle(facts);
  appendProjectContextBundleRecord(projectRoot, bundle);

  const conversation_id = deriveGroundedConversationId({
    purpose: "approval_brief",
    binding_digest: bindingRecordDigest,
    bundle_digest: bundle.record_digest,
  });
  const approvalObject = {
    proposal_id: facts.proposal.proposal_id,
    proposal_content_digest: facts.proposal.content_digest,
    validation_report_digest: facts.validation_report.report_digest,
    review_report_digest: facts.review_report.report_digest,
    risk_assessment_digest: facts.risk_assessment.assessment_digest,
    approval_request_id: deps.approval_request_id,
  };
  const input_digest = contentDigest({
    purpose: "approval_brief",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.approval_brief,
    binding_digest: bindingRecordDigest,
    bundle_digest: bundle.record_digest,
    approval_object: approvalObject,
  });
  const prior = readGroundedSynthesisRecords(projectRoot);
  const reused = prior.filter((record) => record.conversation_id === conversation_id);
  if (reused.some((record) => record.purpose !== "approval_brief")) {
    return blocked(
      "independence_violation",
      "the derived conversation identity was already used by another purpose",
    );
  }
  const replay = reused.find((record) => record.input_digest === input_digest);
  if (replay !== undefined) {
    return { status: "completed", record: replay };
  }

  const input: ApprovalBriefInput = {
    purpose: "approval_brief",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.approval_brief,
    binding_digest: bindingRecordDigest,
    conversation_id,
    run_id: deriveGroundedRunId({ conversation_id, input_digest }),
    bundle,
    approval_object: approvalObject,
  };
  const inputValidation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("approval-brief-input", input);
  if (!inputValidation.valid) {
    return blocked(
      "invalid_output",
      `compiled approval brief input failed its schema: ${inputValidation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }

  // Bounded controlled retry: only retryable failures are re-attempted; the
  // last typed failure is the one surfaced to the Coordinator.
  const maxRetries = deps.maxRetries ?? 1;
  let lastFailure: GroundedSynthesisFailure | undefined;
  let output: ApprovalBriefOutput | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await deps.port.synthesize(input);
    if (result.status === "failed") {
      lastFailure = result.failure;
      if (result.failure.retryable && attempt < maxRetries) continue;
      return { status: "blocked", failure: result.failure };
    }
    const candidate = result.output;
    if (candidate.purpose !== "approval_brief") {
      return blocked(
        "invalid_output",
        `adapter returned a ${String(candidate.purpose)} output for an approval_brief call`,
      );
    }
    output = candidate;
    break;
  }
  if (output === undefined) {
    return blocked(
      lastFailure?.code ?? "uncertain",
      lastFailure?.summary ?? "approval brief produced no output",
    );
  }

  const outputValidation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("approval-brief-output", output);
  if (!outputValidation.valid) {
    return blocked(
      "invalid_output",
      `approval brief output failed its schema: ${outputValidation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  const citationIssues = validateGroundedCitations(output, bundle);
  if (citationIssues.length > 0) {
    const first = citationIssues[0]!;
    return blocked(first.code, `${first.claim_path}: ${first.message}`);
  }

  let record: GroundedSynthesisRecord;
  try {
    record = createGroundedSynthesisRecord({
      purpose: "approval_brief",
      session_id: facts.session.session_id,
      profile_decision_digest: facts.session.profile_decision_digest,
      binding_digest: bindingRecordDigest,
      bundle_digest: bundle.record_digest,
      conversation_id,
      run_id: input.run_id,
      input_digest,
      output,
    });
  } catch (error) {
    if (error instanceof SynthesisRecordError) {
      return blocked("invalid_output", error.message);
    }
    throw error;
  }
  appendGroundedSynthesisRecord(projectRoot, record);
  return { status: "completed", record };
}

/** The committed approval_brief record for one session, if any. */
export function readApprovalBriefRecord(
  projectRoot: string,
  sessionId: string,
): GroundedSynthesisRecord | undefined {
  return readGroundedSynthesisRecords(projectRoot)
    .filter((record) => record.purpose === "approval_brief" && record.session_id === sessionId)
    .at(-1);
}

/** The committed approval bundle for one session, if any. */
export function readApprovalBriefBundle(
  projectRoot: string,
  sessionId: string,
): ProjectContextBundleRecord | undefined {
  return readProjectContextBundles(projectRoot)
    .filter((bundle) => bundle.session_id === sessionId && bundle.purpose === "approval_brief")
    .at(-1);
}

/**
 * Approval Preview (intent-to-prd design 7.5, model advisory design 10): the
 * deterministic facts always come from the committed records; the model brief
 * is attached only when it binds the same approval bundle and passes citation
 * validation, and it can never change the object digest, the risk fields or
 * the scope — the preview reads those from the records, not from the brief.
 */
export interface CaptureApprovalPreview {
  readonly object: {
    readonly proposal_id: string;
    readonly proposal_content_digest: string;
  };
  readonly validation: { readonly passed: boolean; readonly report_digest: string };
  readonly review: {
    readonly verdict: string;
    readonly report_digest: string;
    readonly reviewer_identity: string;
  };
  readonly risk: {
    readonly level: string;
    readonly materiality: string;
    readonly confidence: string;
    readonly assessment_digest: string;
  };
  readonly scope: {
    readonly requirement_count: number;
    readonly constraint_count: number;
    readonly criterion_count: number;
    readonly material: boolean;
  };
  readonly brief_status: "attached" | "absent" | "rejected";
  readonly brief_rejection_reason?: string;
  readonly brief?: {
    readonly record_digest: string;
    readonly changes: ApprovalBriefOutput["changes"];
    readonly risks: ApprovalBriefOutput["risks"];
    readonly tradeoffs: ApprovalBriefOutput["tradeoffs"];
    readonly open_questions: ApprovalBriefOutput["open_questions"];
  };
}

export function buildCaptureApprovalPreview(input: {
  readonly proposal: PrdProposalRecord;
  readonly validation_report: PrdValidationReportRecord;
  readonly review_report: PrdReviewReportRecord;
  readonly risk_assessment: CaptureRiskAssessmentRecord;
  readonly bundle?: ProjectContextBundleRecord;
  readonly brief?: GroundedSynthesisRecord;
}): CaptureApprovalPreview {
  const { proposal, validation_report, review_report, risk_assessment } = input;
  const preview: CaptureApprovalPreview = {
    object: {
      proposal_id: proposal.proposal_id,
      proposal_content_digest: proposal.content_digest,
    },
    validation: {
      passed: validation_report.passed,
      report_digest: validation_report.report_digest,
    },
    review: {
      verdict: review_report.verdict,
      report_digest: review_report.report_digest,
      reviewer_identity: review_report.reviewer_identity,
    },
    risk: {
      level: risk_assessment.level,
      materiality: risk_assessment.materiality,
      confidence: risk_assessment.confidence,
      assessment_digest: risk_assessment.assessment_digest,
    },
    scope: {
      requirement_count: proposal.content.requirements.length,
      constraint_count: proposal.content.constraints.length,
      criterion_count: proposal.content.acceptance_criteria.length,
      material: risk_assessment.materiality === "material",
    },
    brief_status: "absent",
  };
  const brief = input.brief;
  if (brief === undefined) return preview;
  const reject = (reason: string): CaptureApprovalPreview => ({
    ...preview,
    brief_status: "rejected",
    brief_rejection_reason: reason,
  });
  if (brief.purpose !== "approval_brief" || brief.output.purpose !== "approval_brief") {
    return reject("the record is not an approval_brief synthesis");
  }
  const bundle = input.bundle;
  if (bundle === undefined) {
    return reject("no committed approval bundle exists for this session");
  }
  if (brief.output.bundle_digest !== bundle.record_digest) {
    return reject("the brief does not bind the committed approval bundle");
  }
  const proposalSource = bundle.sources.find(
    (source) => source.locator === approvalBriefProposalLocator(proposal.content_digest),
  );
  if (proposalSource === undefined || proposalSource.source_digest !== proposal.record_digest) {
    return reject("the approval bundle does not bind the proposal under approval");
  }
  const citationIssues = validateGroundedCitations(brief.output, bundle);
  if (citationIssues.length > 0) {
    const first = citationIssues[0]!;
    return reject(`${first.claim_path}: ${first.message}`);
  }
  return {
    ...preview,
    brief_status: "attached",
    brief: {
      record_digest: brief.record_digest,
      changes: brief.output.changes,
      risks: brief.output.risks,
      tradeoffs: brief.output.tradeoffs,
      open_questions: brief.output.open_questions,
    },
  };
}
