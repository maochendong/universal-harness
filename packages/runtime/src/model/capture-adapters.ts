import {
  canonicalizeJson,
  promptBindingOfProposalProfile,
  promptBindingOfReviewProfile,
  validateGroundedCitations,
  PRD_PROPOSAL_PROMPT_PORT_ID,
  PRD_REVIEW_PROMPT_PORT_ID,
  PromptContractError,
  type GroundedSynthesisFailure,
  type GroundedSynthesisInput,
  type GroundedSynthesisOutput,
  type GroundedSynthesisPort,
  type GroundedSynthesisResult,
  type PrdPortFailure,
  type PrdProposalDraft,
  type PrdProposalPort,
  type PrdProposalResult,
  type PrdReviewPort,
  type PrdReviewReportDraft,
  type PrdReviewResult,
  type ProfileId,
  type ProjectContextBundleRecord,
  type ProjectContextSource,
  type PromptContractRegistry,
  type PromptPreparationFailure,
  type PromptPreparationFailureCode,
} from "@universal-harness-internal/core";

import type { ManagedInvocationBinding } from "./invocation-records.js";
import { appendModelInvocationRecord } from "./invocation-store.js";
import { transitionModelInvocation } from "./invocation-records.js";
import type { PromptArtifactSink } from "./prompt-artifact.js";
import {
  runManagedInvocation,
  type ManagedInvocationBudget,
  type ManagedModelProviderPort,
} from "./managed-runner.js";
import { compilePrompt, type CompiledPrompt } from "./prompt-compiler.js";
import type { PromptInputBundle, PromptInputItem } from "./source-boundary.js";

/**
 * Model-backed Capture adapters (prompt governance addendum design 7/8, plan
 * PG-2). Each adapter owns exactly one port/purpose: it compiles through the
 * PromptCompiler, invokes through the managed runner and maps outcomes onto
 * the existing domain result types. Preparation failures throw a typed
 * PromptPreparationFailureError — they never masquerade as domain outcomes —
 * and manual/in-memory profiles keep zero compilation and zero invocation.
 */

/** Thrown for preparation-layer failures; carries the typed blocker payload. */
export class PromptPreparationFailureError extends Error {
  readonly failure: PromptPreparationFailure;

  constructor(failure: PromptPreparationFailure) {
    super(failure.summary);
    this.name = "PromptPreparationFailureError";
    this.failure = failure;
  }
}

export interface ModelBackedProviderConfig {
  readonly provider_identity: string;
  readonly config_digest: string;
  readonly budget_profile: string;
}

/** The invocation-layer dependencies every model-backed adapter shares. */
export interface ManagedInvocationAdapterDeps {
  readonly projectRoot: string;
  readonly provider_config: ModelBackedProviderConfig;
  readonly provider?: ManagedModelProviderPort;
  readonly artifact_sink?: PromptArtifactSink;
  readonly budget?: ManagedInvocationBudget;
}

export interface ModelBackedAdapterDeps extends ManagedInvocationAdapterDeps {
  readonly registry: PromptContractRegistry;
  readonly profile_id: ProfileId;
  readonly bundle_content: (source: ProjectContextSource) => string;
}

export const DEFAULT_BUDGET: ManagedInvocationBudget = {
  timeout_ms: 60_000,
  max_output_bytes: 256 * 1024,
} as const;

function preparationFailure(
  code: PromptPreparationFailureCode,
  summary: string,
): PromptPreparationFailureError {
  return new PromptPreparationFailureError({ code, summary, retryable: false });
}

function bindingOf(
  contract: ManagedBackedContractFields,
  config: ModelBackedProviderConfig,
): ManagedInvocationBinding {
  return {
    provider_identity: config.provider_identity,
    config_digest: config.config_digest,
    budget_profile: config.budget_profile,
    prompt_contract_id: contract.prompt_contract_id,
    prompt_contract_version: contract.prompt_contract_version,
    prompt_contract_digest: contract.prompt_contract_digest,
    output_schema_digest: contract.output_schema_digest,
  };
}

export interface ManagedBackedContractFields {
  readonly prompt_contract_id: string;
  readonly prompt_contract_version: string;
  readonly prompt_contract_digest: string;
  readonly output_schema_digest: string;
}

function sourceItems(
  bundle: ProjectContextBundleRecord,
  deps: ModelBackedAdapterDeps,
): PromptInputItem[] {
  return bundle.sources.map((source) => ({
    source_id: source.locator,
    source_kind: source.source_kind,
    text: deps.bundle_content(source),
  }));
}

function compileOrThrow(
  deps: ModelBackedAdapterDeps,
  selector: { port_id: string; purpose?: string; prompt_version: string },
  inputBundle: PromptInputBundle,
): CompiledPrompt {
  const result = compilePrompt({
    registry: deps.registry,
    selector,
    profile: deps.profile_id,
    input_bundle: inputBundle,
  });
  if (!result.ok) {
    throw new PromptPreparationFailureError(result.failure);
  }
  return result.compiled;
}

function runIdFor(conversationId: string): string {
  return `run_${conversationId.replace(/^[a-z][a-z0-9-]*_/u, "")}`;
}

/**
 * Invoke one compiled prompt through the managed runner (shared by every
 * model-backed adapter): a replayed outcome cannot supply the value because
 * raw outputs are never persisted, so it re-runs fresh exactly once.
 */
export async function invokeManagedPrompt(
  deps: ManagedInvocationAdapterDeps,
  request: {
    readonly port_id: string;
    readonly purpose?: string;
    readonly output_schema_id: string;
    readonly invocation_id: string;
    readonly conversation_id: string;
    readonly run_id: string;
    readonly contract: ManagedBackedContractFields;
    readonly compiled: CompiledPrompt;
  },
) {
  const outcome = await runManagedInvocation({
    projectRoot: deps.projectRoot,
    identity: {
      invocation_id: request.invocation_id,
      conversation_id: request.conversation_id,
      run_id: request.run_id,
    },
    port_id: request.port_id,
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    binding: bindingOf(request.contract, deps.provider_config),
    output_schema_id: request.output_schema_id,
    compiled: request.compiled,
    budget: deps.budget ?? DEFAULT_BUDGET,
    ...(deps.provider === undefined ? {} : { provider: deps.provider }),
    ...(deps.artifact_sink === undefined ? {} : { artifact_sink: deps.artifact_sink }),
  });
  if (outcome.status !== "replayed") {
    return outcome;
  }
  // A replay cannot supply the value (raw outputs are never persisted), so
  // the caller crashed between validation and consumption: run fresh, once.
  const fresh = await runManagedInvocation({
    projectRoot: deps.projectRoot,
    identity: {
      invocation_id: request.invocation_id,
      conversation_id: request.conversation_id,
      run_id: request.run_id,
    },
    port_id: request.port_id,
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    binding: bindingOf(request.contract, deps.provider_config),
    output_schema_id: request.output_schema_id,
    compiled: request.compiled,
    budget: deps.budget ?? DEFAULT_BUDGET,
    ...(deps.provider === undefined ? {} : { provider: deps.provider }),
    ...(deps.artifact_sink === undefined ? {} : { artifact_sink: deps.artifact_sink }),
    force_fresh: true,
  });
  if (fresh.status === "replayed") {
    throw new PromptPreparationFailureError({
      code: "prompt_contract_version_mismatch",
      summary: `invocation ${request.invocation_id} replayed even with force_fresh; the store is inconsistent`,
      retryable: false,
    });
  }
  return fresh;
}

/** Mark a validated invocation consumed; the value has left the runner. */
export function consumeManagedInvocation(
  deps: ManagedInvocationAdapterDeps,
  record: Parameters<typeof transitionModelInvocation>[0],
): void {
  appendModelInvocationRecord(deps.projectRoot, transitionModelInvocation(record, "consumed"));
}

/** Invocation failure → PrdPortFailure (design 9.1.1: carriers stay distinct). */
function toPrdPortFailure(failure: {
  readonly code: string;
  readonly summary: string;
  readonly retryable: boolean;
}): PrdPortFailure {
  const code =
    failure.code === "provider_required"
      ? "provider_unavailable"
      : failure.code === "independence_violation"
        ? "policy_denied"
        : failure.code;
  return {
    code: code as PrdPortFailure["code"],
    summary: failure.summary,
    retryable: failure.retryable,
  };
}

/** Invocation failure → GroundedSynthesisFailure (projection, never a second truth). */
function toGroundedFailure(failure: {
  readonly code: string;
  readonly summary: string;
  readonly retryable: boolean;
}): GroundedSynthesisFailure {
  const code =
    failure.code === "timeout"
      ? "provider_unavailable"
      : failure.code === "budget_exhausted"
        ? "uncertain"
        : failure.code;
  return {
    code: code as GroundedSynthesisFailure["code"],
    summary: failure.summary,
    retryable: failure.retryable,
  };
}

export function createModelBackedPrdProposalPort(deps: ModelBackedAdapterDeps): PrdProposalPort {
  return {
    name: "model-backed-prd-proposal",
    async propose(input): Promise<PrdProposalResult> {
      if (input.profile.backing !== "model") {
        throw preparationFailure(
          "prompt_contract_required",
          "the model-backed proposal port requires a model-backed profile",
        );
      }
      let contract;
      try {
        contract = promptBindingOfProposalProfile(input.profile, deps.registry);
      } catch (error) {
        if (error instanceof PromptContractError) {
          throw new PromptPreparationFailureError({
            code: error.code,
            summary: error.message,
            retryable: false,
          });
        }
        throw error;
      }
      if (contract === undefined) {
        throw preparationFailure(
          "prompt_contract_required",
          "the model-backed proposal port requires a model-backed profile",
        );
      }
      const resolution = deps.registry.resolve({
        port_id: PRD_PROPOSAL_PROMPT_PORT_ID,
        prompt_version: input.profile.prompt_version,
      });
      const items: PromptInputItem[] = [
        {
          source_id: "intent",
          source_kind: "intent",
          text: input.session.intent_text,
        },
        // The draft must restate verifiable digests verbatim; they only exist
        // on the session record and the bundle manifest, so they join the
        // prompt explicitly (T24 coordinator dogfood: an invisible digest is
        // a hallucinated one).
        {
          source_id: "session-binding",
          source_kind: "session_binding",
          text: canonicalizeJson({
            intent_digest: input.session.intent_digest,
            proposal_bundle_sources: input.proposal_context_bundle.sources.map((source) => ({
              locator: source.locator,
              source_digest: source.source_digest,
            })),
          }),
        },
        ...sourceItems(input.proposal_context_bundle, deps),
        {
          source_id: "accepted-answers",
          source_kind: "clarification_answers",
          text: canonicalizeJson(input.accepted_answers),
        },
      ];
      const compiled = compileOrThrow(
        deps,
        { port_id: PRD_PROPOSAL_PROMPT_PORT_ID, prompt_version: input.profile.prompt_version },
        { bundle_id: input.proposal_context_bundle.bundle_id, items },
      );
      const outcome = await invokeManagedPrompt(deps, {
        port_id: PRD_PROPOSAL_PROMPT_PORT_ID,
        output_schema_id: resolution.output_schema_id,
        invocation_id: input.invocation.invocation_id,
        conversation_id: input.invocation.conversation_id,
        run_id: runIdFor(input.invocation.conversation_id),
        contract,
        compiled,
      });
      if (outcome.status === "failed") {
        return { status: "failed", failure: toPrdPortFailure(outcome.failure) };
      }
      consumeManagedInvocation(deps, outcome.record);
      return { status: "proposed", draft: outcome.value as PrdProposalDraft };
    },
  };
}

export function createModelBackedPrdReviewPort(deps: ModelBackedAdapterDeps): PrdReviewPort {
  return {
    name: "model-backed-prd-review",
    async review(input): Promise<PrdReviewResult> {
      if (input.profile.backing !== "model") {
        throw preparationFailure(
          "prompt_contract_required",
          "the model-backed review port requires a model-backed profile",
        );
      }
      let contract;
      try {
        contract = promptBindingOfReviewProfile(input.profile, deps.registry);
      } catch (error) {
        if (error instanceof PromptContractError) {
          throw new PromptPreparationFailureError({
            code: error.code,
            summary: error.message,
            retryable: false,
          });
        }
        throw error;
      }
      if (contract === undefined) {
        throw preparationFailure(
          "prompt_contract_required",
          "the model-backed review port requires a model-backed profile",
        );
      }
      const resolution = deps.registry.resolve({
        port_id: PRD_REVIEW_PROMPT_PORT_ID,
        prompt_version: input.profile.prompt_version,
      });
      const items: PromptInputItem[] = [
        ...sourceItems(input.review_context_bundle, deps),
        {
          source_id: "proposal",
          source_kind: "proposal_record",
          text: canonicalizeJson(input.proposal),
        },
        {
          source_id: "validation-report",
          source_kind: "validation_report",
          text: canonicalizeJson(input.validation_report),
        },
        // The rubric's dimension registry must be visible: dimension ids are
        // a closed vocabulary the report validator checks verbatim (T24).
        {
          source_id: "review-rubric",
          source_kind: "review_rubric",
          text: canonicalizeJson(input.rubric),
        },
      ];
      const compiled = compileOrThrow(
        deps,
        { port_id: PRD_REVIEW_PROMPT_PORT_ID, prompt_version: input.profile.prompt_version },
        { bundle_id: input.review_context_bundle.bundle_id, items },
      );
      const outcome = await invokeManagedPrompt(deps, {
        port_id: PRD_REVIEW_PROMPT_PORT_ID,
        output_schema_id: resolution.output_schema_id,
        invocation_id: input.invocation.invocation_id,
        conversation_id: input.invocation.conversation_id,
        run_id: runIdFor(input.invocation.conversation_id),
        contract,
        compiled,
      });
      if (outcome.status === "failed") {
        return { status: "failed", failure: toPrdPortFailure(outcome.failure) };
      }
      consumeManagedInvocation(deps, outcome.record);
      return { status: "completed", report: outcome.value as PrdReviewReportDraft };
    },
  };
}

/**
 * Every shipped grounded purpose has model-backed wiring (T20 slice 2): the
 * Capture-scope purposes (project_discovery/approval_brief) and the pipeline
 * purposes (context_enrichment/iteration_narrative) share the same compile →
 * invoke → citation-validate path; anything outside the fixed union still
 * fails closed.
 */
const SYNTHESIS_PURPOSE_BY_INPUT = new Set([
  "project_discovery",
  "approval_brief",
  "context_enrichment",
  "iteration_narrative",
]);

export function createModelBackedGroundedSynthesisPort(
  deps: ModelBackedAdapterDeps,
): GroundedSynthesisPort {
  return {
    name: "model-backed-grounded-synthesis",
    async synthesize(input: GroundedSynthesisInput): Promise<GroundedSynthesisResult> {
      if (!SYNTHESIS_PURPOSE_BY_INPUT.has(input.purpose)) {
        return {
          status: "failed",
          failure: {
            code: "unknown_purpose",
            summary: `purpose ${input.purpose} has no model-backed wiring in this build`,
            retryable: false,
          },
        };
      }
      const wired = input as Extract<
        GroundedSynthesisInput,
        { readonly bundle: ProjectContextBundleRecord }
      >;
      const contract = deps.registry.resolve({
        port_id: "grounded_synthesis",
        purpose: wired.purpose,
        prompt_version: `${wired.purpose.replace(/_/gu, "-")}.v1`,
      });
      const items: PromptInputItem[] = [
        ...sourceItems(wired.bundle, deps),
        {
          source_id: "synthesis-input",
          source_kind: "synthesis_input",
          text: canonicalizeJson({
            ...wired,
            bundle: wired.bundle.record_digest,
            // Citation fidelity (T23): the model must copy locator/digest
            // pairs verbatim, so the manifest has to name them explicitly —
            // the per-source content items alone never surface the digest.
            bundle_sources: wired.bundle.sources.map((source) => ({
              locator: source.locator,
              source_digest: source.source_digest,
            })),
          }),
        },
      ];
      const compiled = compileOrThrow(
        deps,
        {
          port_id: "grounded_synthesis",
          purpose: wired.purpose,
          prompt_version: `${wired.purpose.replace(/_/gu, "-")}.v1`,
        },
        { bundle_id: wired.bundle.bundle_id, items },
      );
      const outcome = await invokeManagedPrompt(deps, {
        port_id: "grounded_synthesis",
        purpose: wired.purpose,
        output_schema_id: contract.output_schema_id,
        // The purpose must stay inside the invocation id: the pipeline mints
        // conversation ids as `<purpose-words>-conversation_<operation>` and
        // the prefix strip would collapse enrichment and narrative of one
        // operation onto the same id — an identity_conflict (T23 dogfood).
        invocation_id: `invocation_${wired.purpose}_${wired.conversation_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
        conversation_id: wired.conversation_id,
        run_id: wired.run_id,
        contract,
        compiled,
      });
      if (outcome.status === "failed") {
        return { status: "failed", failure: toGroundedFailure(outcome.failure) };
      }
      const output = outcome.value as GroundedSynthesisOutput;
      const citationIssues = validateGroundedCitations(output, wired.bundle);
      if (citationIssues.length > 0) {
        const first = citationIssues[0]!;
        return {
          status: "failed",
          failure: { code: first.code, summary: first.message, retryable: false },
        };
      }
      consumeManagedInvocation(deps, outcome.record);
      return { status: "completed", output };
    },
  };
}
