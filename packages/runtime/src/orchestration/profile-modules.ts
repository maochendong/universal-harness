import {
  createCapabilityStatusProjector,
  readLatestProjectProfile,
  type CapabilityId,
  type CapabilityStatusProjection,
  type NodeRecord,
  type ProjectProfileRecord,
} from "@universal-harness-internal/core";

import { createAuditContribution } from "./contributors/audit-contributor.js";
import { createEvaluationContribution } from "./contributors/evaluation-contributor.js";
import { createImpactContribution } from "./contributors/impact-contributor.js";
import type { ModuleContributions } from "./kernel-coordinator.js";
import {
  MODULE_STATUS_MAPPINGS,
  deriveModuleDomainStatus,
  isModuleStatusCapability,
} from "./module-status.js";

/**
 * The single profile → module-resolution derivation (plan T9). An explicit
 * Lite profile deactivates every module capability; design_governance and
 * strict_tdd report inactive in every profile until their work packages wire
 * them. The facade trim and the status Read API both consume this function —
 * the kernel coordinator itself never sees a profile.
 */
export interface ProfileModuleResolution {
  readonly capability_id: CapabilityId;
  readonly resolution: "active" | "inactive_by_profile";
}

const PIPELINE_MODULE_CAPABILITIES = [
  "impact_analysis",
  "independent_evaluation",
  "advanced_audit",
] as const;

const UNWIRED_CAPABILITIES: readonly CapabilityId[] = ["design_governance", "strict_tdd"];

export function resolveProfileModules(
  profile: ProjectProfileRecord | undefined,
): readonly ProfileModuleResolution[] {
  const lite = profile?.profile_id === "lite";
  return [
    ...PIPELINE_MODULE_CAPABILITIES.map((capabilityId): ProfileModuleResolution => ({
      capability_id: capabilityId,
      resolution: lite ? "inactive_by_profile" : "active",
    })),
    ...UNWIRED_CAPABILITIES.map((capabilityId): ProfileModuleResolution => ({
      capability_id: capabilityId,
      resolution: "inactive_by_profile",
    })),
  ];
}

/** The facade composition point: contributors only for active capabilities. */
export function moduleContributionsForProfile(
  projectRoot: string,
  projectId: string,
): ModuleContributions {
  const resolutions = resolveProfileModules(readLatestProjectProfile(projectRoot, projectId));
  const active = new Set(
    resolutions
      .filter((resolution) => resolution.resolution === "active")
      .map((resolution) => resolution.capability_id),
  );
  return {
    ...(active.has("impact_analysis") ? { impact: createImpactContribution() } : {}),
    ...(active.has("independent_evaluation") ? { evaluate: createEvaluationContribution() } : {}),
    ...(active.has("advanced_audit") ? { audit: createAuditContribution() } : {}),
  };
}

const projector = createCapabilityStatusProjector(MODULE_STATUS_MAPPINGS);

/**
 * One entry of the capability status Read API (plan T9/T10, slim-profiles
 * design 7.5). Inactive capabilities carry the generic
 * `not_enabled_by_profile` projection; active pipeline modules project their
 * own domain status, derived from committed graph facts and mapped to the
 * slim five through the module-registered mappings. Without graph evidence
 * an active capability makes no proof claim at all.
 */
export interface ProfileModuleStatusEntry {
  readonly capability_id: CapabilityId;
  readonly resolution: "active" | "inactive_by_profile";
  readonly generic_status?: CapabilityStatusProjection["generic_status"];
  readonly domain_status?: string;
}

/** Graph facts the module status derivation reads. */
export interface ModuleStatusEvidence {
  readonly nodes: readonly NodeRecord[];
}

export function projectProfileModuleStatus(
  profile: ProjectProfileRecord | undefined,
  evidence?: ModuleStatusEvidence,
): readonly ProfileModuleStatusEntry[] {
  return resolveProfileModules(profile).map((resolution): ProfileModuleStatusEntry => {
    if (
      resolution.resolution === "active" &&
      evidence !== undefined &&
      isModuleStatusCapability(resolution.capability_id)
    ) {
      const domainStatus = deriveModuleDomainStatus(resolution.capability_id, evidence.nodes);
      const projection = projector.project(resolution.capability_id, domainStatus);
      return {
        capability_id: resolution.capability_id,
        resolution: resolution.resolution,
        generic_status: projection.generic_status,
        domain_status: projection.domain_status,
      };
    }
    if (resolution.resolution === "active") {
      return { capability_id: resolution.capability_id, resolution: resolution.resolution };
    }
    return {
      capability_id: resolution.capability_id,
      resolution: resolution.resolution,
      generic_status: projector.inactive(resolution.capability_id).generic_status,
    };
  });
}
