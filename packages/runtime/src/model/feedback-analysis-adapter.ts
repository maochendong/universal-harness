import {
  canonicalizeJson,
  FEEDBACK_ANALYSIS_PROMPT_PORT_ID,
  FEEDBACK_ANALYSIS_PROMPT_VERSION,
  validateFeedbackAnalysisOutput,
  type FeedbackAnalysisInput,
  type FeedbackAnalysisOutput,
  type FeedbackAnalysisPort,
  type FeedbackAnalysisResult,
  type ProfileId,
  type ProjectContextSource,
  type PromptContractRegistry,
} from "@universal-harness-internal/core";

import {
  PromptPreparationFailureError,
  consumeManagedInvocation,
  invokeManagedPrompt,
  type ManagedInvocationAdapterDeps,
  type ModelBackedProviderConfig,
} from "./capture-adapters.js";
import { compilePrompt } from "./prompt-compiler.js";

export interface FeedbackAnalysisAdapterDeps extends ManagedInvocationAdapterDeps {
  readonly registry: PromptContractRegistry;
  readonly profile_id: ProfileId;
  readonly provider_config: ModelBackedProviderConfig;
  readonly bundle_content: (source: ProjectContextSource) => string;
  readonly prompt_version?: string;
}

/** Model advisory adapter: separate prompt/run identity, cited output only. */
export function createModelBackedFeedbackAnalysisPort(
  deps: FeedbackAnalysisAdapterDeps,
): FeedbackAnalysisPort {
  return {
    name: "model-backed-feedback-analysis",
    async analyze(input: FeedbackAnalysisInput): Promise<FeedbackAnalysisResult> {
      const promptVersion = deps.prompt_version ?? FEEDBACK_ANALYSIS_PROMPT_VERSION;
      const resolution = deps.registry.resolve({
        port_id: FEEDBACK_ANALYSIS_PROMPT_PORT_ID,
        prompt_version: promptVersion,
      });
      const compiled = compilePrompt({
        registry: deps.registry,
        selector: { port_id: FEEDBACK_ANALYSIS_PROMPT_PORT_ID, prompt_version: promptVersion },
        profile: deps.profile_id,
        input_bundle: {
          bundle_id: `feedback-analysis_${input.finding_digest.slice(0, 16)}`,
          items: [
            {
              source_id: "feedback-analysis-input",
              source_kind: "feedback_analysis_input",
              text: canonicalizeJson(input),
            },
            ...input.bundle.sources.map((source) => ({
              source_id: source.locator,
              source_kind: source.source_kind,
              text: deps.bundle_content(source),
            })),
          ],
        },
      });
      if (!compiled.ok) throw new PromptPreparationFailureError(compiled.failure);
      const outcome = await invokeManagedPrompt(deps, {
        port_id: FEEDBACK_ANALYSIS_PROMPT_PORT_ID,
        output_schema_id: resolution.output_schema_id,
        invocation_id: `feedback-analysis-invocation_${input.run_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        contract: resolution,
        compiled: compiled.compiled,
      });
      if (outcome.status === "failed") return { status: "failed", failure: outcome.failure };
      const output = outcome.value as FeedbackAnalysisOutput;
      const issues = validateFeedbackAnalysisOutput({
        output,
        finding_digest: input.finding_digest,
        fact_digests: Object.fromEntries(
          input.bundle.sources.map((source) => [source.locator, source.source_digest]),
        ),
      });
      if (issues.length > 0) {
        return {
          status: "failed",
          failure: {
            code: "invalid_output",
            summary: `feedback analysis failed result validation: ${issues
              .map((issue) => issue.code)
              .join(", ")}`,
            retryable: false,
          },
        };
      }
      consumeManagedInvocation(deps, outcome.record);
      return { status: "completed", output };
    },
  };
}
