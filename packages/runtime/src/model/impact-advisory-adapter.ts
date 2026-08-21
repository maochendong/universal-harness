import {
  canonicalizeJson,
  type ProfileId,
  type PromptContractRegistry,
} from "@universal-harness-internal/core";
import {
  IMPACT_ADVISORY_PROMPT_PORT_ID,
  IMPACT_ADVISORY_PROMPT_VERSION,
  validateImpactAdvisoryMerge,
  type ImpactAdvisoryInput,
  type ImpactAdvisoryPort,
  type ImpactAdvisoryResult,
} from "@universal-harness-internal/graph";
import type { ImpactAdvisoryOutput } from "@universal-harness-internal/core";

import {
  PromptPreparationFailureError,
  consumeManagedInvocation,
  invokeManagedPrompt,
  type ManagedInvocationAdapterDeps,
  type ModelBackedProviderConfig,
} from "./capture-adapters.js";
import { compilePrompt } from "./prompt-compiler.js";

/**
 * The model-backed ImpactAdvisoryPort (model advisory design 6, prompt
 * governance addendum PG-3). The advisory input enters the compiled prompt as
 * untrusted data with the whole graph itemized: the summary item carries
 * node id/type/digest references only, and every node is its own item so a
 * real project's graph stays under the per-item size budget (the single
 * whole-graph item exceeded it on the T21 dogfood). Every binding fact lands
 * in the compiled digest. The raw model output is schema-validated by the
 * managed runner and then merge-validated against the deterministic set;
 * anything unmergable fails closed as `invalid_output` and is never consumed.
 */
export interface ImpactAdvisoryAdapterDeps extends ManagedInvocationAdapterDeps {
  readonly registry: PromptContractRegistry;
  readonly profile_id: ProfileId;
  readonly provider_config: ModelBackedProviderConfig;
  /** Defaults to the shipped contract alias `impact_advisory.v1`. */
  readonly prompt_version?: string;
}

export function createModelBackedImpactAdvisoryPort(
  deps: ImpactAdvisoryAdapterDeps,
): ImpactAdvisoryPort {
  return {
    name: "model-backed-impact-advisory",
    async advise(input: ImpactAdvisoryInput): Promise<ImpactAdvisoryResult> {
      const promptVersion = deps.prompt_version ?? IMPACT_ADVISORY_PROMPT_VERSION;
      const resolution = deps.registry.resolve({
        port_id: IMPACT_ADVISORY_PROMPT_PORT_ID,
        prompt_version: promptVersion,
      });
      const compiled = compilePrompt({
        registry: deps.registry,
        selector: { port_id: IMPACT_ADVISORY_PROMPT_PORT_ID, prompt_version: promptVersion },
        profile: deps.profile_id,
        input_bundle: {
          bundle_id: `impact-advisory_${input.impact_set_digest.slice(0, 16)}`,
          items: [
            {
              source_id: "impact-advisory-input",
              source_kind: "impact_advisory_input",
              text: canonicalizeJson({
                ...input,
                nodes: input.nodes.map((node) => ({
                  id: node.id,
                  type: node.type,
                  digest: node.digest,
                })),
              }),
            },
            ...input.nodes.map((node) => ({
              source_id: `node:${node.id}`,
              source_kind: "graph_node",
              text: canonicalizeJson(node),
            })),
          ],
        },
      });
      if (!compiled.ok) {
        throw new PromptPreparationFailureError(compiled.failure);
      }
      const outcome = await invokeManagedPrompt(deps, {
        port_id: IMPACT_ADVISORY_PROMPT_PORT_ID,
        output_schema_id: resolution.output_schema_id,
        invocation_id: `impact-advisory-invocation_${input.run_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        contract: resolution,
        compiled: compiled.compiled,
      });
      if (outcome.status === "failed") {
        return { status: "failed", failure: outcome.failure };
      }
      const output = outcome.value as ImpactAdvisoryOutput;
      const issues = validateImpactAdvisoryMerge({
        output,
        deterministic_entries: input.deterministic_entries,
        impact_set_digest: input.impact_set_digest,
        nodes: input.nodes,
        requirement_digests: input.requirement_digests,
        rule_registry_version: input.rule_registry_version,
        rule_registry_digest: input.rule_registry_digest,
      });
      if (issues.length > 0) {
        // Domain rejection: the invocation stays validated-but-unconsumed, and
        // the deterministic set proceeds without the advisory.
        return {
          status: "failed",
          failure: {
            code: "invalid_output",
            summary: `advisory failed merge validation: ${issues
              .map((issue) => issue.code)
              .join(", ")}`,
            retryable: false,
          },
        };
      }
      consumeManagedInvocation(deps, outcome.record);
      const proposesContent =
        output.additions.length > 0 ||
        output.edge_candidates.length > 0 ||
        output.risk_signals.length > 0 ||
        output.missing_facts.length > 0;
      if (!proposesContent && output.questions.length > 0) {
        return { status: "clarification_required", questions: output.questions };
      }
      return {
        status: "proposed",
        additions: output.additions,
        edge_candidates: output.edge_candidates,
        risk_signals: output.risk_signals,
        missing_facts: output.missing_facts,
        questions: output.questions,
      };
    },
  };
}
