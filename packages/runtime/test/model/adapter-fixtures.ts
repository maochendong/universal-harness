import {
  contentDigest,
  createCaptureSessionRecord,
  createPrdProposalRecord,
  createPrdValidationReportRecord,
  createProjectContextBundleRecord,
  createPromptContractRegistry,
  resolveModelBackedProposalProfile,
  resolveModelBackedReviewProfile,
  runPrdHardGates,
  APPROVAL_BRIEF_PROMPT_REGISTRATION,
  CONTEXT_ENRICHMENT_PROMPT_REGISTRATION,
  ITERATION_NARRATIVE_PROMPT_REGISTRATION,
  PRD_PROPOSAL_PROMPT_REGISTRATION,
  PRD_REVIEW_PROMPT_REGISTRATION,
  PROJECT_DISCOVERY_PROMPT_REGISTRATION,
  type CaptureSessionRecord,
  type ModelBackedCaptureProposalProfile,
  type ModelBackedCaptureReviewProfile,
  type PrdProposalDraft,
  type PrdProposalRecord,
  type PrdValidationReportRecord,
  type ProjectContextBundleRecord,
  type ProjectContextSource,
  type PromptContractRegistry,
} from "@universal-harness-internal/core";

/**
 * PG-2 capture-adapter fixtures: real records built through the core
 * factories, a two-source content-addressed bundle and the registered
 * Capture/pipeline grounded prompt contracts.
 */
export const ADAPTER_DIGESTS = {
  adapter_profile: "e".repeat(64),
  prompt_version: "f".repeat(64),
} as const;

export const SOURCE_TEXTS: Readonly<Record<string, string>> = {
  "README.md": "# Demo\nA demo reporting application.",
  "package.json": '{ "name": "demo" }',
};

export function adapterSession(intent = "Let users export the monthly report as a CSV file.") {
  return createCaptureSessionRecord({
    workflow_operation_id: "operation_01K1ABCDEFGHIJKLMNO",
    iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
    intent_text: intent,
    project_profile_digest: "a".repeat(64),
    profile_decision_digest: "b".repeat(64),
    capture_policy_digest: "c".repeat(64),
    project_baseline_digest: "d".repeat(64),
  });
}

export function adapterSources(): readonly ProjectContextSource[] {
  return [
    {
      locator: "README.md",
      source_kind: "readme",
      source_digest: contentDigest(SOURCE_TEXTS["README.md"]),
      selection_reason: "project overview",
      classification: "public_project",
      summary: "Demo reporting application.",
      truncated: false,
    },
    {
      locator: "package.json",
      source_kind: "manifest",
      source_digest: contentDigest(SOURCE_TEXTS["package.json"]),
      selection_reason: "package manifest",
      classification: "public_project",
      summary: "Node package manifest.",
      truncated: false,
    },
  ];
}

export function adapterBundle(
  session: CaptureSessionRecord,
  purpose: "proposal" | "review" | "approval_brief" | "context_enrichment",
): ProjectContextBundleRecord {
  return createProjectContextBundleRecord({
    session_id: session.session_id,
    purpose,
    project_baseline_digest: session.project_baseline_digest,
    profile_digest: session.project_profile_digest,
    policy_digest: session.capture_policy_digest,
    budget: {
      max_files: 10,
      max_bytes_per_source: 4096,
      max_total_bytes: 16384,
      max_summary_chars: 500,
    },
    sources: adapterSources(),
    exclusions: [],
  });
}

export function adapterBundleContent(source: ProjectContextSource): string {
  const text = SOURCE_TEXTS[source.locator];
  if (text === undefined) throw new Error(`no fixture content for ${source.locator}`);
  return text;
}

export function adapterRegistry(): PromptContractRegistry {
  return createPromptContractRegistry([
    PRD_PROPOSAL_PROMPT_REGISTRATION,
    PRD_REVIEW_PROMPT_REGISTRATION,
    PROJECT_DISCOVERY_PROMPT_REGISTRATION,
    APPROVAL_BRIEF_PROMPT_REGISTRATION,
    CONTEXT_ENRICHMENT_PROMPT_REGISTRATION,
    ITERATION_NARRATIVE_PROMPT_REGISTRATION,
  ]);
}

export function validDraft(session: CaptureSessionRecord): PrdProposalDraft {
  const binding = {
    source_kind: "intent" as const,
    source_id: "intent",
    source_digest: session.intent_digest,
  };
  return {
    schema_version: "1.1.0",
    intent: { text: session.intent_text, digest: session.intent_digest },
    problem_statement: "Users cannot archive monthly reports outside the application.",
    goals: [
      {
        draft_key: "goal-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "Users can export the monthly report as a CSV file.",
      },
    ],
    non_goals: [],
    actors: [],
    scenarios: [],
    requirements: [
      {
        draft_key: "req-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "The user can export the monthly report as a CSV file.",
        priority: "must",
        change_kind: "must_change",
        scenario_ids: [],
        acceptance_criterion_ids: ["criterion-1"],
      },
    ],
    constraints: [],
    acceptance_criteria: [
      {
        draft_key: "criterion-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        requirement_id: "req-1",
        precondition: "a monthly report exists for the user",
        action: "the user exports the report as CSV",
        observable_outcome: "a CSV file containing the report rows is produced",
        verification_intent: "compare the exported CSV rows with the report data",
        test_first_example:
          "given an existing report, exporting produces a CSV whose rows match the report",
        scenario_kind: "primary",
      },
    ],
    assumptions: [],
    dependencies: [],
    risks: [],
    open_questions: [],
    glossary: [],
    context_source_refs: [],
  };
}

export function proposalProfile(
  registry: PromptContractRegistry,
): ModelBackedCaptureProposalProfile {
  return resolveModelBackedProposalProfile({
    resolver: registry,
    adapter_profile_digest: ADAPTER_DIGESTS.adapter_profile,
    prompt_version_digest: ADAPTER_DIGESTS.prompt_version,
    producer_identity: "test-proposal-adapter",
    prompt_version: "prd-proposal.v1",
  });
}

export function reviewProfile(registry: PromptContractRegistry): ModelBackedCaptureReviewProfile {
  return resolveModelBackedReviewProfile({
    resolver: registry,
    adapter_profile_digest: ADAPTER_DIGESTS.adapter_profile,
    prompt_version_digest: ADAPTER_DIGESTS.prompt_version,
    producer_identity: "test-review-adapter",
    prompt_version: "prd-review.v1",
  });
}

export function proposalRecord(
  session: CaptureSessionRecord,
  bundle: ProjectContextBundleRecord,
): PrdProposalRecord {
  const created = createPrdProposalRecord({
    session,
    revision: 1,
    draft: validDraft(session),
    proposal_context_bundle: bundle,
    answers: [],
    adapter_profile_digest: ADAPTER_DIGESTS.adapter_profile,
    prompt_version_digest: ADAPTER_DIGESTS.prompt_version,
    producer_identity: "test-proposal-adapter",
    invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
    conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
    evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
  });
  return created.record;
}

export function validationReport(
  session: CaptureSessionRecord,
  proposal: PrdProposalRecord,
): PrdValidationReportRecord {
  const gates = runPrdHardGates(proposal.content);
  return createPrdValidationReportRecord({
    session_id: session.session_id,
    proposal_digest: proposal.record_digest,
    results: gates.results,
    blocking_question_ids: [],
  });
}
