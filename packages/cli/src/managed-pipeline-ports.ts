import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalizeJson,
  harnessRootFor,
  type DesignProposalPort,
  type DesignReviewPort,
  type GroundedSynthesisPort,
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
 * output schema validation); a slot with no coverage yields no port and the
 * pipeline keeps its current deterministic/blocked behavior — nothing fails
 * open. The prd_review/project_discovery/approval_brief slots stay unwired
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

/** The pipeline ports the orchestrator dependencies accept; absent slots stay absent. */
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
  if (deps.runtimeConfig.model_providers === undefined) return {};
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
            ...shared,
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
