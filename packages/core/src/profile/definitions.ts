import { contentDigest } from "../identity/digest.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import {
  PROFILE_IDS,
  type CapabilityId,
  type CapabilityMode,
  type ProfileDefinition,
  type ProfileId,
} from "../schema/profile.js";

/**
 * The three protocol 1.1 profile definitions (slim-profiles design 7). They
 * are protocol registry data — never project records — so every tier carries
 * a deterministic `definition_digest` that ProjectProfileRecords reference;
 * a same-named capability drifting between versions changes the digest and
 * fails closed downstream instead of being silently reinterpreted.
 */
export class ProfileRegistryError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Unknown project profile: ${reason}`);
    this.name = "ProfileRegistryError";
    this.reason = reason;
  }
}

function defineProfile(
  profileId: ProfileId,
  capabilities: Record<CapabilityId, CapabilityMode>,
): ProfileDefinition {
  const definition = {
    profile_id: profileId,
    protocol_version: PROTOCOL_1_1_VERSION,
    capabilities,
    approval_policy_id: `approval-policy-${profileId}`,
    dashboard_presentation_id: `dashboard-presentation-${profileId}`,
    cli_presentation_id: `cli-presentation-${profileId}`,
  } as const;
  return { ...definition, definition_digest: contentDigest(definition) };
}

export const PROFILE_DEFINITIONS: readonly ProfileDefinition[] = [
  defineProfile("lite", {
    impact_analysis: "conditional",
    design_governance: "conditional",
    independent_evaluation: "conditional",
    strict_tdd: "conditional",
    advanced_audit: "conditional",
  }),
  defineProfile("standard", {
    impact_analysis: "required",
    design_governance: "required",
    independent_evaluation: "required",
    strict_tdd: "conditional",
    advanced_audit: "conditional",
  }),
  defineProfile("governed", {
    impact_analysis: "required",
    design_governance: "required",
    independent_evaluation: "required",
    strict_tdd: "required",
    advanced_audit: "required",
  }),
];

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === "string" && (PROFILE_IDS as readonly string[]).includes(value);
}

/** Fail-closed lookup: unknown tiers are rejected, never mapped to Lite. */
export function profileDefinition(profileId: string): ProfileDefinition {
  const definition = PROFILE_DEFINITIONS.find((entry) => entry.profile_id === profileId);
  if (definition === undefined) {
    throw new ProfileRegistryError(profileId);
  }
  return definition;
}

/** Tier ordering lite < standard < governed for upgrade/downgrade decisions. */
export function profileRank(profileId: ProfileId): number {
  return PROFILE_IDS.indexOf(profileId);
}
