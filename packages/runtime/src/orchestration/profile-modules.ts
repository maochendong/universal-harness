import {
  createCapabilityStatusProjector,
  readLatestProjectProfile,
  type CapabilityId,
  type CapabilityStatusProjection,
  type ProjectProfileRecord,
} from "@universal-harness-internal/core";

import { createAuditContribution } from "./contributors/audit-contributor.js";
import { createEvaluationContribution } from "./contributors/evaluation-contributor.js";
import { createImpactContribution } from "./contributors/impact-contributor.js";
import type { ModuleContributions } from "./kernel-coordinator.js";

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

const projector = createCapabilityStatusProjector([]);

/**
 * One entry of the capability status Read API (plan T9, slim-profiles design
 * 7.5). Inactive capabilities carry the generic `not_enabled_by_profile`
 * projection through the registered projector; active capabilities make no
 * proof claim here — their proof states arrive with the owning modules.
 */
export interface ProfileModuleStatusEntry {
  readonly capability_id: CapabilityId;
  readonly resolution: "active" | "inactive_by_profile";
  readonly generic_status?: CapabilityStatusProjection["generic_status"];
}

export function projectProfileModuleStatus(
  profile: ProjectProfileRecord | undefined,
): readonly ProfileModuleStatusEntry[] {
  return resolveProfileModules(profile).map((resolution): ProfileModuleStatusEntry => {
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
