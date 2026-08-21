import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PRD_PROPOSAL_PROMPT_PORT_ID,
  PRD_PROPOSAL_PROMPT_VERSION,
  allowedSourceKindsForProfile,
  contentDigest,
  createCaptureSessionRecord,
  createLocalGitProjectContextAdapter,
  resolveModelBackedProposalProfile,
  type ClarificationQuestionDraft,
  type PrdProposalPort,
  type PrdProposalResult,
  type ProfileId,
  type ProjectContextBudget,
  type ProjectContextSource,
} from "@universal-harness-internal/core";
import {
  createModelBackedPrdProposalPort,
  type ClarificationQuestion,
  type IntentInterpreter,
} from "@universal-harness-internal/runtime";

import { assembleModelProviders } from "./model-providers.js";
import { createShippedPromptContractRegistry } from "./prompt-registry.js";
import type { ProjectRuntimeConfig } from "./project-runtime-config.js";

/**
 * T20 slice 1: routes the legacy capture interpreter seam through the managed
 * model layer. When the committed project runtime config declares a provider
 * covering the `prd_proposal` slot, the returned IntentInterpreter compiles a
 * proposal-purpose context bundle through the local-git adapter and asks the
 * model-backed PRD proposal port for a draft; otherwise the factory returns
 * undefined and the caller keeps the generic interpreter. Every degradation
 * (blocked bundle, port failure, malformed clarification) fails closed by
 * throwing — nothing is silently completed. API keys never travel through
 * here: only the env var names reach the provider instances.
 */

/** Digests the capture session record binds; supplied by the caller, never invented. */
export interface ManagedInterpreterSessionContext {
  readonly project_profile_digest: string;
  readonly profile_decision_digest: string;
  readonly capture_policy_digest: string;
  readonly project_baseline_digest: string;
}

export interface ManagedIntentInterpreterDeps {
  readonly projectRoot: string;
  readonly runtimeConfig: ProjectRuntimeConfig;
  readonly profile_id: ProfileId;
  readonly session_context: ManagedInterpreterSessionContext;
  readonly newId: (kind: string) => string;
  readonly fetch?: typeof fetch;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Test seam: replace the model-backed proposal port. The clarification
   * mapping is unreachable through the shipped provider (its output schema is
   * always a draft), so tests exercise it through a stubbed port.
   */
  readonly proposal_port?: PrdProposalPort;
}

/** Proposal-bundle budget; mirrors the core local-git adapter test defaults. */
const PROPOSAL_CONTEXT_BUDGET: ProjectContextBudget = {
  max_files: 16,
  max_bytes_per_source: 4096,
  max_total_bytes: 65536,
  max_summary_chars: 400,
} as const;

const PRODUCER_IDENTITY = "universal-harness-cli" as const;

function failClosed(message: string): never {
  throw new Error(`managed capture interpreter: ${message}`);
}

/** The raw bytes of one bundled source; the bundle only ever lists vetted candidate paths. */
function bundleContent(projectRoot: string, source: ProjectContextSource): string {
  return readFileSync(join(projectRoot, source.locator), "utf8");
}

function subjectOf(draft: ClarificationQuestionDraft): ClarificationQuestion["subject"] {
  switch (draft.target_kind) {
    case "requirement":
    case "constraint":
      return draft.target_kind;
    case "acceptance_criterion":
      return "acceptance";
    default:
      return "intent";
  }
}

/**
 * The orchestrator only accepts optioned questions (2-4 distinct non-blank
 * options per question; it appends the `other` escape itself). A model offer
 * without usable options is a port error, not a free-text fallback.
 */
function toClarificationOffer(questions: readonly ClarificationQuestionDraft[]): {
  readonly clarification: readonly ClarificationQuestion[];
} {
  if (questions.length === 0) {
    failClosed("clarification_required carried no questions");
  }
  return {
    clarification: questions.map((draft) => {
      const options = [
        ...new Set(
          (draft.options ?? [])
            .map((option) => option.label.trim())
            .filter((label) => label.length > 0 && label !== "other"),
        ),
      ];
      if (options.length < 2 || options.length > 4) {
        failClosed(
          `clarification question ${JSON.stringify(draft.question)} must offer 2-4 ` +
            `distinct options, got ${String((draft.options ?? []).length)}`,
        );
      }
      return { subject: subjectOf(draft), question: draft.question, options };
    }),
  };
}

function mapResult(result: PrdProposalResult): ReturnType<IntentInterpreter> {
  if (result.status === "failed") {
    failClosed(`proposal failed (${result.failure.code}): ${result.failure.summary}`);
  }
  if (result.status === "clarification_required") {
    return toClarificationOffer(result.questions);
  }
  const draft = result.draft;
  if (draft.requirements.length === 0) return undefined;
  return {
    requirements: draft.requirements.map((requirement) => ({
      statement: requirement.statement,
      acceptance: draft.acceptance_criteria
        .filter((criterion) => criterion.requirement_id === requirement.draft_key)
        .map((criterion) => ({
          description: `${criterion.action} → ${criterion.observable_outcome}`,
          verification: criterion.verification_intent,
        })),
    })),
    constraints: draft.constraints.map((constraint) => ({
      statement: constraint.statement,
      verification: constraint.verification_intent,
    })),
  };
}

export function createManagedIntentInterpreter(
  deps: ManagedIntentInterpreterDeps,
): IntentInterpreter | undefined {
  const resolver = assembleModelProviders(deps.runtimeConfig, {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.environment === undefined ? {} : { environment: deps.environment }),
  });
  const resolved = resolver.resolve(PRD_PROPOSAL_PROMPT_PORT_ID);
  if (resolved === undefined) return undefined;

  const registry = createShippedPromptContractRegistry();
  const contextAdapter = createLocalGitProjectContextAdapter({ projectRoot: deps.projectRoot });
  const profile = resolveModelBackedProposalProfile({
    resolver: registry,
    // No adapter-profile/prompt-version records exist on this legacy path yet;
    // both digests derive deterministically from the stable inputs.
    adapter_profile_digest: contentDigest({
      producer_identity: PRODUCER_IDENTITY,
      prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
      profile_id: deps.profile_id,
    }),
    prompt_version_digest: contentDigest(PRD_PROPOSAL_PROMPT_VERSION),
    producer_identity: PRODUCER_IDENTITY,
    prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
  });
  const port =
    deps.proposal_port ??
    createModelBackedPrdProposalPort({
      projectRoot: deps.projectRoot,
      registry,
      profile_id: deps.profile_id,
      provider_config: resolved.provider_config,
      provider: resolved.provider,
      bundle_content: (source) => bundleContent(deps.projectRoot, source),
    });

  return async (intent: string) => {
    const session = createCaptureSessionRecord({
      workflow_operation_id: deps.newId("operation"),
      iteration_id: deps.newId("iteration"),
      intent_text: intent,
      ...deps.session_context,
    });
    const compiled = await contextAdapter.compile({
      session_id: session.session_id,
      purpose: "proposal",
      intent_text: intent,
      project_root_kind: "managed",
      project_baseline_digest: deps.session_context.project_baseline_digest,
      project_profile_digest: deps.session_context.project_profile_digest,
      capture_policy_digest: deps.session_context.capture_policy_digest,
      allowed_source_kinds: allowedSourceKindsForProfile(deps.profile_id),
      path_policy: {},
      budget: PROPOSAL_CONTEXT_BUDGET,
    });
    if (compiled.status !== "compiled") {
      failClosed(`context bundle blocked (${compiled.failure.code}): ${compiled.failure.summary}`);
    }
    const invocationId = deps.newId("capture-invocation");
    const result = await port.propose({
      session,
      proposal_context_bundle: compiled.bundle,
      accepted_answers: [],
      profile,
      invocation: {
        invocation_id: invocationId,
        conversation_id: deps.newId("capture-conversation"),
        evidence_locator: `capture-evidence://${invocationId}`,
      },
    });
    return mapResult(result);
  };
}
