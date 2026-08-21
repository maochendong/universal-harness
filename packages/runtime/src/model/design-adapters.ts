import {
  canonicalizeJson,
  parseDesignProposalOutput,
  validateDesignReviewOutput,
  DESIGN_PROPOSAL_PROMPT_PORT_ID,
  DESIGN_PROPOSAL_PROMPT_VERSION,
  DESIGN_REVIEW_PROMPT_PORT_ID,
  DESIGN_REVIEW_PROMPT_VERSION,
  type DesignProposalPort,
  type DesignProposalResult,
  type DesignReviewDraft,
  type DesignReviewPort,
  type DesignReviewResult,
  type DesignProposalInput,
  type DesignReviewInput,
  type DesignProposalOutput,
  type DesignReviewOutput,
  type ModelPortFailure,
  type ProfileId,
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
import type { PromptInputItem } from "./source-boundary.js";

/**
 * The model-backed design ports (model advisory design 6/7, prompt
 * governance addendum PG-4, plan T12). Each port compiles its own isolated
 * contract, invokes through the managed runner and validates the output
 * against the domain rules before anything is consumed: the proposal parser
 * maps raw payloads onto proposed/clarification/failed, the review result
 * validator re-checks verdicts, citations and coverage. A rejected output
 * stays validated-but-unconsumed and fails closed as `invalid_output`.
 *
 * Input fidelity (T21 real-provider dogfood): the typed input carries only
 * ids and digests, which a deterministic port can script against but a model
 * cannot design from — the first real run correctly returned clarification
 * questions asking for the requirement content. When the host supplies
 * `node_content`, the bound requirement/test nodes join the prompt as
 * per-node untrusted items; without it the compilation stays digest-only.
 */
export interface DesignProposalAdapterDeps extends ManagedInvocationAdapterDeps {
  readonly registry: PromptContractRegistry;
  readonly profile_id: ProfileId;
  readonly provider_config: ModelBackedProviderConfig;
  /** Defaults to the shipped contract alias `design_proposal.v1`. */
  readonly prompt_version?: string;
  /** Resolves a bound graph node to its canonical content; throws on drift. */
  readonly node_content?: (nodeId: string) => string;
}

export interface DesignReviewAdapterDeps extends ManagedInvocationAdapterDeps {
  readonly registry: PromptContractRegistry;
  readonly profile_id: ProfileId;
  readonly provider_config: ModelBackedProviderConfig;
  /** Defaults to the shipped contract alias `design_review.v1`. */
  readonly prompt_version?: string;
  /** Resolves a bound graph node to its canonical content; throws on drift. */
  readonly node_content?: (nodeId: string) => string;
}

/** One untrusted item per bound node; ids are deduplicated for stable digests. */
function nodeItems(
  nodeIds: readonly string[],
  deps: { readonly node_content?: (nodeId: string) => string },
): PromptInputItem[] {
  if (deps.node_content === undefined) return [];
  const resolve = deps.node_content;
  return [...new Set(nodeIds)].sort().map((nodeId) => ({
    source_id: `node:${nodeId}`,
    source_kind: "graph_node",
    text: resolve(nodeId),
  }));
}

function invalidOutput(summary: string): ModelPortFailure {
  return { code: "invalid_output", summary, retryable: false };
}

export function createModelBackedDesignProposalPort(
  deps: DesignProposalAdapterDeps,
): DesignProposalPort {
  return {
    name: "model-backed-design-proposal",
    async propose(input: DesignProposalInput): Promise<DesignProposalResult> {
      const promptVersion = deps.prompt_version ?? DESIGN_PROPOSAL_PROMPT_VERSION;
      const resolution = deps.registry.resolve({
        port_id: DESIGN_PROPOSAL_PROMPT_PORT_ID,
        prompt_version: promptVersion,
      });
      const compiled = compilePrompt({
        registry: deps.registry,
        selector: { port_id: DESIGN_PROPOSAL_PROMPT_PORT_ID, prompt_version: promptVersion },
        profile: deps.profile_id,
        input_bundle: {
          bundle_id: `design-proposal_${input.bundle_digest.slice(0, 16)}`,
          items: [
            {
              source_id: "design-proposal-input",
              source_kind: "design_proposal_input",
              text: canonicalizeJson(input),
            },
            ...nodeItems(
              [
                ...input.must_change_requirement_ids,
                ...input.criterion_test_pairs.map((pair) => pair.test_node_id),
              ],
              deps,
            ),
          ],
        },
      });
      if (!compiled.ok) {
        throw new PromptPreparationFailureError(compiled.failure);
      }
      const outcome = await invokeManagedPrompt(deps, {
        port_id: DESIGN_PROPOSAL_PROMPT_PORT_ID,
        output_schema_id: resolution.output_schema_id,
        invocation_id: `design-proposal-invocation_${input.run_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        contract: resolution,
        compiled: compiled.compiled,
      });
      if (outcome.status === "failed") {
        return { status: "failed", failure: outcome.failure };
      }
      const result = parseDesignProposalOutput(outcome.value as DesignProposalOutput);
      if (result.status === "failed") {
        // Domain rejection: never consumed, never partially applied.
        return result;
      }
      consumeManagedInvocation(deps, outcome.record);
      return result;
    },
  };
}

export function createModelBackedDesignReviewPort(deps: DesignReviewAdapterDeps): DesignReviewPort {
  return {
    name: "model-backed-design-review",
    async review(input: DesignReviewInput): Promise<DesignReviewResult> {
      const promptVersion = deps.prompt_version ?? DESIGN_REVIEW_PROMPT_VERSION;
      const resolution = deps.registry.resolve({
        port_id: DESIGN_REVIEW_PROMPT_PORT_ID,
        prompt_version: promptVersion,
      });
      const compiled = compilePrompt({
        registry: deps.registry,
        selector: { port_id: DESIGN_REVIEW_PROMPT_PORT_ID, prompt_version: promptVersion },
        profile: deps.profile_id,
        input_bundle: {
          bundle_id: `design-review_${input.bundle_digest.slice(0, 16)}`,
          items: [
            {
              source_id: "design-review-input",
              source_kind: "design_review_input",
              text: canonicalizeJson(input),
            },
            ...nodeItems(input.must_change_requirement_ids, deps),
          ],
        },
      });
      if (!compiled.ok) {
        throw new PromptPreparationFailureError(compiled.failure);
      }
      const outcome = await invokeManagedPrompt(deps, {
        port_id: DESIGN_REVIEW_PROMPT_PORT_ID,
        output_schema_id: resolution.output_schema_id,
        invocation_id: `design-review-invocation_${input.run_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        contract: resolution,
        compiled: compiled.compiled,
      });
      if (outcome.status === "failed") {
        return { status: "failed", failure: outcome.failure };
      }
      const output = outcome.value as DesignReviewOutput;
      const draft: DesignReviewDraft = {
        verdict: output.verdict,
        findings: output.findings,
        coverage_assessment: output.coverage_assessment,
        residual_risks: output.residual_risks,
        summary: output.summary,
      };
      const issues = validateDesignReviewOutput({
        output: draft,
        bundle_sources: input.bundle_sources,
        proposal_content: input.proposal_content,
        must_change_requirement_ids: input.must_change_requirement_ids,
      });
      if (issues.length > 0) {
        return {
          status: "failed",
          failure: invalidOutput(
            `design review failed result validation: ${issues
              .map((issue) => issue.code)
              .join(", ")}`,
          ),
        };
      }
      consumeManagedInvocation(deps, outcome.record);
      return {
        status: draft.verdict,
        findings: draft.findings,
        coverage_assessment: draft.coverage_assessment,
        residual_risks: draft.residual_risks,
        summary: draft.summary,
      };
    },
  };
}
