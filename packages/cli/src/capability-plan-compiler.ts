import {
  CONTEXT_ENRICHMENT_PROMPT_VERSION,
  DESIGN_REVIEW_PROMPT_VERSION,
  DESIGN_REVIEW_SCHEMA_VERSION,
  FEEDBACK_ANALYSIS_PROMPT_VERSION,
  FEEDBACK_ANALYSIS_SCHEMA_VERSION,
  GROUNDED_SYNTHESIS_SCHEMA_VERSIONS,
  IMPACT_ADVISORY_SCHEMA_VERSION,
  ITERATION_NARRATIVE_PROMPT_VERSION,
  PLAN_PROPOSAL_SCHEMA_VERSION,
  compileCapabilityPlan,
  readCaptureModelProviderBindings,
  readLatestProjectProfile,
  readManagedManifest,
  readProfileDecisionRecords,
  type ModelProviderConfig,
  type ProfileDecisionRecord,
  type ProjectProfileRecord,
  type TrustedProviderRegistry,
} from "@universal-harness-internal/core";
import {
  IMPACT_ADVISORY_PROMPT_PORT_ID,
  IMPACT_ADVISORY_PROMPT_VERSION,
} from "@universal-harness-internal/graph";
import {
  PLAN_PROPOSAL_PROMPT_PORT_ID,
  PLAN_PROPOSAL_PROMPT_VERSION,
  type CapabilityPlanCompilerPort,
  type ResolvedManagedProvider,
} from "@universal-harness-internal/runtime";

import { assembleModelProviders } from "./model-providers.js";
import { createShippedPromptContractRegistry } from "./prompt-registry.js";
import type { ProjectRuntimeConfig } from "./project-runtime-config.js";

export interface CapabilityPlanCompilerDependencies {
  readonly projectRoot: string;
  readonly runtimeConfig: ProjectRuntimeConfig;
  readonly fetch?: typeof fetch;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly providerRegistry?: TrustedProviderRegistry;
}

export class CapabilityPlanCompilerConfigurationError extends Error {
  readonly kind = "capability_plan_compiler_configuration" as const;

  constructor(message: string) {
    super(message);
    this.name = "CapabilityPlanCompilerConfigurationError";
  }
}

interface OperationSlot {
  readonly slot_id: ModelProviderConfig["slot_id"];
  readonly purpose?: ModelProviderConfig["purpose"];
  readonly resolver_key: string;
  readonly prompt_version: string;
  readonly schema_version: string;
}

const OPERATION_SLOTS: readonly OperationSlot[] = [
  {
    slot_id: "impact_advisory",
    resolver_key: IMPACT_ADVISORY_PROMPT_PORT_ID,
    prompt_version: IMPACT_ADVISORY_PROMPT_VERSION,
    schema_version: IMPACT_ADVISORY_SCHEMA_VERSION,
  },
  {
    slot_id: "design_review",
    resolver_key: "design_review",
    prompt_version: DESIGN_REVIEW_PROMPT_VERSION,
    schema_version: DESIGN_REVIEW_SCHEMA_VERSION,
  },
  {
    slot_id: "plan_proposal",
    resolver_key: PLAN_PROPOSAL_PROMPT_PORT_ID,
    prompt_version: PLAN_PROPOSAL_PROMPT_VERSION,
    schema_version: PLAN_PROPOSAL_SCHEMA_VERSION,
  },
  {
    slot_id: "feedback_analysis",
    resolver_key: "feedback_analysis",
    prompt_version: FEEDBACK_ANALYSIS_PROMPT_VERSION,
    schema_version: FEEDBACK_ANALYSIS_SCHEMA_VERSION,
  },
  {
    slot_id: "grounded_synthesis",
    purpose: "context_enrichment",
    resolver_key: "context_enrichment",
    prompt_version: CONTEXT_ENRICHMENT_PROMPT_VERSION,
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.context_enrichment,
  },
  {
    slot_id: "grounded_synthesis",
    purpose: "iteration_narrative",
    resolver_key: "iteration_narrative",
    prompt_version: ITERATION_NARRATIVE_PROMPT_VERSION,
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.iteration_narrative,
  },
];

function profileAndDecision(projectRoot: string): {
  readonly profile: ProjectProfileRecord;
  readonly decision: ProfileDecisionRecord;
} {
  const projectId = `project_${readManagedManifest(projectRoot).name}`;
  const profile = readLatestProjectProfile(projectRoot, projectId);
  if (profile === undefined) {
    throw new CapabilityPlanCompilerConfigurationError(
      `Protocol 1.1 project ${projectId} has no accepted ProjectProfile`,
    );
  }
  const decision = readProfileDecisionRecords(projectRoot)
    .filter(
      (candidate) =>
        candidate.project_id === projectId && candidate.decided_profile_id === profile.profile_id,
    )
    .at(-1);
  if (decision === undefined) {
    throw new CapabilityPlanCompilerConfigurationError(
      `ProjectProfile ${profile.record_digest} has no persisted ProfileDecision`,
    );
  }
  return { profile, decision };
}

function modelProviderConfig(
  slot: OperationSlot,
  resolved: ResolvedManagedProvider,
): ModelProviderConfig {
  return {
    slot_id: slot.slot_id,
    ...(slot.purpose === undefined ? {} : { purpose: slot.purpose }),
    provider_identity: resolved.provider_config.provider_identity,
    config_digest: resolved.provider_config.config_digest,
    prompt_version: slot.prompt_version,
    schema_version: slot.schema_version,
    budget_profile: resolved.provider_config.budget_profile,
  };
}

/**
 * Host composition for the Protocol 1.1 compiler. Repository configuration
 * contributes provider references only; identities, endpoints, prompt
 * contracts and credentials are all resolved from host-owned registries.
 */
export function createProjectCapabilityPlanCompiler(
  deps: CapabilityPlanCompilerDependencies,
): CapabilityPlanCompilerPort {
  const { profile, decision } = profileAndDecision(deps.projectRoot);
  const providers = assembleModelProviders(deps.runtimeConfig, {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.environment === undefined ? {} : { environment: deps.environment }),
    ...(deps.providerRegistry === undefined ? {} : { registry: deps.providerRegistry }),
  });
  const promptContracts = createShippedPromptContractRegistry();
  const captureBindings = readCaptureModelProviderBindings(deps.projectRoot)
    .filter(
      (record) =>
        record.profile_decision_id === decision.profile_decision_id &&
        record.profile_decision_digest === decision.record_digest,
    )
    .at(-1)?.bindings;

  return (request) => {
    const effectiveStage =
      request.stage === "initial"
        ? profile.profile_id === "standard"
          ? "provisional"
          : "final"
        : request.stage;
    const modelProviders = OPERATION_SLOTS.flatMap((slot) => {
      const resolved = providers.resolve(slot.resolver_key);
      return resolved === undefined ? [] : [modelProviderConfig(slot, resolved)];
    });
    const plan = compileCapabilityPlan({
      operation_id: request.operation_id,
      stage: effectiveStage,
      project_profile: profile,
      profile_decision: decision,
      requirement_digest: request.requirement_digest,
      risk_digest: request.risk_digest,
      policy_digest: request.policy_digest,
      baseline_digest: request.baseline_digest,
      providers: ["isolated_workspace_provider", "structured_gate_provider"],
      model_providers: modelProviders,
      prompt_contract_resolver: promptContracts,
      ...(captureBindings === undefined ? {} : { capture_scope_bindings: captureBindings }),
      ...(request.accepted_design_set === undefined
        ? {}
        : { accepted_design_set: request.accepted_design_set }),
      ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
    });
    if (plan.operation_id !== request.operation_id || plan.compilation_stage !== effectiveStage) {
      throw new CapabilityPlanCompilerConfigurationError(
        "Capability Compiler returned a plan outside the requested operation/stage binding",
      );
    }
    return plan;
  };
}
