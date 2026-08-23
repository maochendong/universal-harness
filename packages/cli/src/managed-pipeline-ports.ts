import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bindingScopeKey,
  canonicalizeJson,
  harnessRootFor,
  modelSlotDefaultsForProfile,
  type DesignProposalPort,
  type DesignReviewPort,
  type GroundedSynthesisPort,
  type GroundedSynthesisPurpose,
  type ModelSlotId,
  type ProfileId,
  type ProjectContextSource,
  DESIGN_PROPOSAL_PROMPT_PORT_ID,
  DESIGN_REVIEW_PROMPT_PORT_ID,
} from "@universal-harness-internal/core";
import {
  IMPACT_ADVISORY_PROMPT_PORT_ID,
  type ImpactAdvisoryPort,
} from "@universal-harness-internal/graph";
import {
  createModelBackedDesignProposalPort,
  createModelBackedDesignReviewPort,
  createModelBackedGroundedSynthesisPort,
  createModelBackedImpactAdvisoryPort,
  createModelBackedPlanProposalPort,
  materializeProjectGraph,
  PLAN_PROPOSAL_PROMPT_PORT_ID,
  type ManagedInvocationBudget,
  type PlanProposalPort,
  type ResolvedManagedProvider,
} from "@universal-harness-internal/runtime";

import { assembleModelProviders } from "./model-providers.js";
import { createShippedPromptContractRegistry } from "./prompt-registry.js";
import type { ProjectRuntimeConfig } from "./project-runtime-config.js";

/**
 * T20 slice 2: routes the design/impact/plan/context pipeline seams through
 * the managed model layer. For every slot the committed runtime config covers,
 * the matching model-backed port is constructed on the managed invocation
 * layer (compiled prompt contracts, persisted invocation records, pinned
 * output schema validation). Coverage is profile-aware (design 11.2): a
 * Standard/Governed project must declare providers for every required
 * blocking slot this assembly wires — a missing `model_providers` config or
 * an uncovered required slot throws ManagedPipelinePortsError instead of
 * degrading to the deterministic/legacy path. Lite keeps the optional
 * behavior: a slot with no coverage yields no port and the pipeline keeps its
 * current deterministic/blocked behavior. The
 * prd_review/project_discovery/approval_brief slots stay unwired
 * here on purpose: their only consumption point is the protocol-1.1 capture
 * coordinator, which the legacy pipeline never drives. API keys never travel
 * through here: only the env var names reach the provider instances.
 */

export interface ManagedPipelinePortsDeps {
  readonly projectRoot: string;
  readonly runtimeConfig: ProjectRuntimeConfig;
  readonly profile_id: ProfileId;
  readonly fetch?: typeof fetch;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * The pipeline ports the orchestrator dependencies accept; optional slots the
 * config does not cover stay absent, while required slots of a
 * Standard/Governed profile fail closed in the factory before this is built.
 */
export interface ManagedPipelinePorts {
  readonly design?: {
    readonly proposal?: DesignProposalPort;
    readonly review?: DesignReviewPort;
  };
  readonly impactAdvisory?: ImpactAdvisoryPort;
  readonly planProposal?: PlanProposalPort;
  readonly contextEnrichment?: GroundedSynthesisPort;
  readonly iterationNarrative?: GroundedSynthesisPort;
}

const SNAPSHOT_LOCATOR_PREFIX = "harness://snapshots/" as const;
const NODE_LOCATOR_PREFIX = "node://" as const;

export type ManagedPipelinePortsErrorCode = "provider_required";

/**
 * Preflight coverage failure (design 11.2/13): a Standard/Governed operation
 * hit a required blocking slot with no declared provider. Surfaced by the
 * runtime service as an OrchestrationError of kind "configuration".
 */
export class ManagedPipelinePortsError extends Error {
  readonly code: ManagedPipelinePortsErrorCode = "provider_required";

  constructor(profileId: ProfileId, missing: readonly string[]) {
    super(
      `managed pipeline ports: profile ${profileId} requires model provider coverage for ` +
        `slot(s): ${missing.join(", ")}; declare model_providers in the committed runtime config`,
    );
    this.name = "ManagedPipelinePortsError";
  }
}

/**
 * The 11.2 operation-scope slots this assembly wires, with the resolver key
 * each resolves under. `feedback_analysis` has no production call point yet
 * and `iteration_narrative` is the sole non-blocking slot (its failure may
 * only raise a projection finding), so neither is preflight-enforced here.
 */
const PIPELINE_SLOT_RESOLVER_KEYS: readonly {
  readonly slot_id: ModelSlotId;
  readonly purpose?: GroundedSynthesisPurpose;
  readonly resolver_key: string;
}[] = [
  { slot_id: "impact_advisory", resolver_key: IMPACT_ADVISORY_PROMPT_PORT_ID },
  { slot_id: "design_review", resolver_key: DESIGN_REVIEW_PROMPT_PORT_ID },
  { slot_id: "plan_proposal", resolver_key: PLAN_PROPOSAL_PROMPT_PORT_ID },
  {
    slot_id: "grounded_synthesis",
    purpose: "context_enrichment",
    resolver_key: "context_enrichment",
  },
];

/**
 * Resolver keys the profile slot matrix (design 11.2) marks required and
 * blocking among the slots this assembly wires. Empty for Lite.
 */
function requiredPipelineSlotKeysForProfile(profileId: ProfileId): readonly string[] {
  const defaults = new Map(
    modelSlotDefaultsForProfile(profileId).map((slot) => [bindingScopeKey(slot), slot]),
  );
  return PIPELINE_SLOT_RESOLVER_KEYS.filter(({ slot_id, purpose }) => {
    const slotDefault = defaults.get(
      bindingScopeKey({ slot_id, ...(purpose === undefined ? {} : { purpose }) }),
    );
    return slotDefault?.required === true && slotDefault.failure_mode === "block";
  }).map(({ resolver_key }) => resolver_key);
}

/**
 * Whether the tier forces managed model coverage (design 11.2): Standard and
 * Governed carry required blocking slots; every Lite slot is optional.
 */
export function profileRequiresManagedModelPorts(profileId: ProfileId): boolean {
  return modelSlotDefaultsForProfile(profileId).some(
    (slot) => slot.required && slot.failure_mode === "block",
  );
}

function failClosed(message: string): never {
  throw new Error(`managed pipeline ports: ${message}`);
}

/**
 * Resolves one bound graph node to its canonical content for the design
 * ports. A node the contributor bound but the graph no longer carries is
 * binding drift and fails closed — the model must never design against an
 * invented node.
 */
function pipelineNodeContent(projectRoot: string, nodeId: string): string {
  const graph = materializeProjectGraph(projectRoot);
  try {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) {
      failClosed(`design input node ${nodeId} does not resolve to a project graph node`);
    }
    return canonicalizeJson(node);
  } finally {
    graph.close();
  }
}

/**
 * Resolves one bundled source back to its content. Enrichment and narrative
 * bundles cite graph nodes and committed snapshots rather than loose files:
 * node locators (and bare file locators, which are node locators first)
 * resolve through the materialized project graph exactly as the context
 * compiler saw them; snapshot locators read the committed ledger artifact.
 * An unresolvable source fails closed — a prompt must never be compiled over
 * invented content.
 */
function pipelineBundleContent(projectRoot: string, source: ProjectContextSource): string {
  if (source.locator.startsWith(SNAPSHOT_LOCATOR_PREFIX)) {
    const snapshotId = source.locator.slice(SNAPSHOT_LOCATOR_PREFIX.length);
    return readFileSync(
      join(harnessRootFor(projectRoot), "artifacts", "snapshots", `${snapshotId}.json`),
      "utf8",
    );
  }
  const graph = materializeProjectGraph(projectRoot);
  try {
    const node = source.locator.startsWith(NODE_LOCATOR_PREFIX)
      ? graph.nodes.find((candidate) => candidate.id === source.locator.slice(7))
      : graph.nodes.find((candidate) => candidate.locator === source.locator);
    if (node === undefined) {
      failClosed(`bundle source ${source.locator} does not resolve to a project graph node`);
    }
    return canonicalizeJson(node);
  } finally {
    graph.close();
  }
}

export function createManagedPipelinePorts(deps: ManagedPipelinePortsDeps): ManagedPipelinePorts {
  const requiredSlotKeys = requiredPipelineSlotKeysForProfile(deps.profile_id);
  // Lite with no declared providers keeps the exact legacy fallback; a tier
  // with required slots falls through so the coverage check below throws.
  if (deps.runtimeConfig.model_providers === undefined && requiredSlotKeys.length === 0) {
    return {};
  }
  const resolver = assembleModelProviders(deps.runtimeConfig, {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.environment === undefined ? {} : { environment: deps.environment }),
  });
  const registry = createShippedPromptContractRegistry();
  const shared = {
    projectRoot: deps.projectRoot,
    registry,
    profile_id: deps.profile_id,
  } as const;

  const designProposal = resolver.resolve(DESIGN_PROPOSAL_PROMPT_PORT_ID);
  const designReview = resolver.resolve(DESIGN_REVIEW_PROMPT_PORT_ID);
  const impactAdvisory = resolver.resolve(IMPACT_ADVISORY_PROMPT_PORT_ID);
  const planProposal = resolver.resolve(PLAN_PROPOSAL_PROMPT_PORT_ID);
  const contextEnrichment = resolver.resolve("context_enrichment");
  const iterationNarrative = resolver.resolve("iteration_narrative");

  // Provider closure is re-verified deterministically at preflight (design
  // 11.2): a required blocking slot with no coverage must never degrade to
  // the deterministic/legacy path.
  const resolvedByKey: Readonly<Record<string, ResolvedManagedProvider | undefined>> = {
    [DESIGN_PROPOSAL_PROMPT_PORT_ID]: designProposal,
    [DESIGN_REVIEW_PROMPT_PORT_ID]: designReview,
    [IMPACT_ADVISORY_PROMPT_PORT_ID]: impactAdvisory,
    [PLAN_PROPOSAL_PROMPT_PORT_ID]: planProposal,
    context_enrichment: contextEnrichment,
    iteration_narrative: iterationNarrative,
  };
  const uncovered = requiredSlotKeys.filter((key) => resolvedByKey[key] === undefined);
  if (uncovered.length > 0) {
    throw new ManagedPipelinePortsError(deps.profile_id, uncovered);
  }

  const groundedDeps = {
    ...shared,
    bundle_content: (source: ProjectContextSource) =>
      pipelineBundleContent(deps.projectRoot, source),
  } as const;

  const designDeps = {
    ...shared,
    node_content: (nodeId: string) => pipelineNodeContent(deps.projectRoot, nodeId),
  } as const;

  /** The resolved provider's declared budget, when the assembly supplied one. */
  const budgetOf = (resolved: ResolvedManagedProvider): { budget?: ManagedInvocationBudget } =>
    resolved.budget === undefined ? {} : { budget: resolved.budget };

  return {
    ...(designProposal === undefined && designReview === undefined
      ? {}
      : {
          design: {
            ...(designProposal === undefined
              ? {}
              : {
                  proposal: createModelBackedDesignProposalPort({
                    ...designDeps,
                    provider_config: designProposal.provider_config,
                    provider: designProposal.provider,
                    ...budgetOf(designProposal),
                  }),
                }),
            ...(designReview === undefined
              ? {}
              : {
                  review: createModelBackedDesignReviewPort({
                    ...designDeps,
                    provider_config: designReview.provider_config,
                    provider: designReview.provider,
                    ...budgetOf(designReview),
                  }),
                }),
          },
        }),
    ...(impactAdvisory === undefined
      ? {}
      : {
          impactAdvisory: createModelBackedImpactAdvisoryPort({
            ...shared,
            provider_config: impactAdvisory.provider_config,
            provider: impactAdvisory.provider,
            ...budgetOf(impactAdvisory),
          }),
        }),
    ...(planProposal === undefined
      ? {}
      : {
          planProposal: createModelBackedPlanProposalPort({
            ...designDeps,
            provider_config: planProposal.provider_config,
            provider: planProposal.provider,
            ...budgetOf(planProposal),
          }),
        }),
    ...(contextEnrichment === undefined
      ? {}
      : {
          contextEnrichment: createModelBackedGroundedSynthesisPort({
            ...groundedDeps,
            provider_config: contextEnrichment.provider_config,
            provider: contextEnrichment.provider,
            ...budgetOf(contextEnrichment),
          }),
        }),
    ...(iterationNarrative === undefined
      ? {}
      : {
          iterationNarrative: createModelBackedGroundedSynthesisPort({
            ...groundedDeps,
            provider_config: iterationNarrative.provider_config,
            provider: iterationNarrative.provider,
            ...budgetOf(iterationNarrative),
          }),
        }),
  };
}
