import {
  canonicalizeJson,
  type ModelPortFailure,
  type ProfileId,
  type PromptContractRegistry,
} from "@universal-harness-internal/core";

import {
  PLAN_PROPOSAL_PROMPT_PORT_ID,
  PLAN_PROPOSAL_PROMPT_VERSION,
} from "../planning/plan-prompt-contract.js";
import {
  parsePlanProposalOutput,
  validatePlanProposalAllocation,
  type PlanProposalInput,
  type PlanProposalPort,
  type PlanProposalResult,
} from "../planning/plan-proposal.js";
import {
  PromptPreparationFailureError,
  consumeManagedInvocation,
  invokeManagedPrompt,
  type ManagedInvocationAdapterDeps,
  type ModelBackedProviderConfig,
} from "./capture-adapters.js";
import { compilePrompt } from "./prompt-compiler.js";

/**
 * The model-backed plan proposal port (model advisory design 8, prompt
 * governance addendum PG-5, plan T13). The port compiles the isolated
 * plan_proposal contract over the Harness-compiled canonical assertion
 * descriptors, invokes through the managed runner and re-validates the
 * allocation deterministically before anything is consumed: created, merged
 * or omitted assertions, unknown gates, widened paths, unknown bindings,
 * cycles and DAG overruns all fail closed as `invalid_output` and stay
 * validated-but-unconsumed. The model improves decomposition quality, never
 * its authority.
 */
export interface PlanProposalAdapterDeps extends ManagedInvocationAdapterDeps {
  readonly registry: PromptContractRegistry;
  readonly profile_id: ProfileId;
  readonly provider_config: ModelBackedProviderConfig;
  /** Defaults to the shipped contract alias `plan_proposal.v1`. */
  readonly prompt_version?: string;
}

function invalidOutput(summary: string): ModelPortFailure {
  return { code: "invalid_output", summary, retryable: false };
}

export function createModelBackedPlanProposalPort(deps: PlanProposalAdapterDeps): PlanProposalPort {
  return {
    name: "model-backed-plan-proposal",
    async propose(input: PlanProposalInput): Promise<PlanProposalResult> {
      const promptVersion = deps.prompt_version ?? PLAN_PROPOSAL_PROMPT_VERSION;
      const resolution = deps.registry.resolve({
        port_id: PLAN_PROPOSAL_PROMPT_PORT_ID,
        prompt_version: promptVersion,
      });
      const compiled = compilePrompt({
        registry: deps.registry,
        selector: { port_id: PLAN_PROPOSAL_PROMPT_PORT_ID, prompt_version: promptVersion },
        profile: deps.profile_id,
        input_bundle: {
          bundle_id: `plan-proposal_${input.bundle_digest.slice(0, 16)}`,
          items: [
            {
              source_id: "plan-proposal-input",
              source_kind: "plan_proposal_input",
              text: canonicalizeJson(input),
            },
          ],
        },
      });
      if (!compiled.ok) {
        throw new PromptPreparationFailureError(compiled.failure);
      }
      const outcome = await invokeManagedPrompt(deps, {
        port_id: PLAN_PROPOSAL_PROMPT_PORT_ID,
        output_schema_id: resolution.output_schema_id,
        invocation_id: `plan-proposal-invocation_${input.run_id.replace(/^[a-z][a-z0-9-]*_/u, "")}`,
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        contract: resolution,
        compiled: compiled.compiled,
      });
      if (outcome.status === "failed") {
        return { status: "failed", failure: outcome.failure };
      }
      const parsed = parsePlanProposalOutput(outcome.value);
      if (parsed.status !== "proposed") {
        // Domain rejection or clarification: never partially applied.
        return parsed;
      }
      const issues = validatePlanProposalAllocation({
        tasks: parsed.tasks,
        canonical_assertions: input.canonical_assertions,
        known_gate_ids: input.known_gate_ids,
        allowed_write_paths: input.allowed_write_paths,
        known_requirement_ids: input.known_requirement_ids,
        known_decision_ids: input.known_decision_ids,
        known_design_artifact_ids: input.known_design_artifact_ids,
        max_tasks: input.max_tasks,
      });
      if (issues.length > 0) {
        return {
          status: "failed",
          failure: invalidOutput(
            `plan proposal failed allocation validation: ${issues
              .map((issue) => issue.code)
              .join(", ")}`,
          ),
        };
      }
      consumeManagedInvocation(deps, outcome.record);
      return parsed;
    },
  };
}
