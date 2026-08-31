import { contentDigest } from "../identity/digest.js";
import { PROTOCOL_1_1_VERSION, PROTOCOL_1_3_VERSION } from "../protocol.js";
import {
  PROFILE_IDS,
  type CapabilityId,
  type CapabilityIdV13,
  type CapabilityMode,
  type ProfileDefinition,
  type ProfileDefinitionV11,
  type ProfileDefinitionV13,
  type ProfileId,
} from "../schema/profile.js";

/**
 * The protocol profile definitions, versioned per protocol (slim-profiles
 * design 7; M4 design 10.2). They are protocol registry data — never project
 * records — so every tier carries a deterministic `definition_digest` that
 * ProjectProfileRecords reference; a same-named capability drifting between
 * versions changes the digest and fails closed downstream instead of being
 * silently reinterpreted. Protocol 1.0–1.2 operations keep resolving the 1.1
 * definitions; Protocol 1.3 adds `parallel_task_execution` as a sealed new
 * definition set without rotating the legacy digests.
 */
export class ProfileRegistryError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Unknown project profile: ${reason}`);
    this.name = "ProfileRegistryError";
    this.reason = reason;
  }
}

/** The protocol versions that carry their own profile definition set. */
export const PROFILE_DEFINITION_PROTOCOL_VERSIONS = [
  PROTOCOL_1_1_VERSION,
  PROTOCOL_1_3_VERSION,
] as const;
export type ProfileDefinitionProtocolVersion =
  (typeof PROFILE_DEFINITION_PROTOCOL_VERSIONS)[number];

function defineProfileV11(
  profileId: ProfileId,
  capabilities: Record<CapabilityId, CapabilityMode>,
): ProfileDefinitionV11 {
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

function defineProfileV13(
  profileId: ProfileId,
  capabilities: Record<CapabilityIdV13, CapabilityMode>,
): ProfileDefinitionV13 {
  const definition = {
    profile_id: profileId,
    protocol_version: PROTOCOL_1_3_VERSION,
    capabilities,
    approval_policy_id: `approval-policy-${profileId}`,
    dashboard_presentation_id: `dashboard-presentation-${profileId}`,
    cli_presentation_id: `cli-presentation-${profileId}`,
  } as const;
  return { ...definition, definition_digest: contentDigest(definition) };
}

export const PROFILE_DEFINITIONS: readonly ProfileDefinitionV11[] = [
  defineProfileV11("lite", {
    impact_analysis: "conditional",
    design_governance: "conditional",
    independent_evaluation: "conditional",
    strict_tdd: "conditional",
    advanced_audit: "conditional",
  }),
  defineProfileV11("standard", {
    impact_analysis: "required",
    design_governance: "required",
    independent_evaluation: "required",
    strict_tdd: "conditional",
    advanced_audit: "conditional",
  }),
  defineProfileV11("governed", {
    impact_analysis: "required",
    design_governance: "required",
    independent_evaluation: "required",
    strict_tdd: "required",
    advanced_audit: "required",
  }),
];

/**
 * Protocol 1.3 definitions (M4 design 10.2): every inherited mode is identical
 * to the 1.1 tier; only `parallel_task_execution` is new — Lite disables it,
 * Standard/Governed require it.
 */
export const PROFILE_DEFINITIONS_1_3: readonly ProfileDefinitionV13[] = [
  defineProfileV13("lite", {
    impact_analysis: "conditional",
    design_governance: "conditional",
    independent_evaluation: "conditional",
    strict_tdd: "conditional",
    advanced_audit: "conditional",
    parallel_task_execution: "disabled",
  }),
  defineProfileV13("standard", {
    impact_analysis: "required",
    design_governance: "required",
    independent_evaluation: "required",
    strict_tdd: "conditional",
    advanced_audit: "conditional",
    parallel_task_execution: "required",
  }),
  defineProfileV13("governed", {
    impact_analysis: "required",
    design_governance: "required",
    independent_evaluation: "required",
    strict_tdd: "required",
    advanced_audit: "required",
    parallel_task_execution: "required",
  }),
];

const DEFINITIONS_BY_VERSION = {
  [PROTOCOL_1_1_VERSION]: PROFILE_DEFINITIONS,
  [PROTOCOL_1_3_VERSION]: PROFILE_DEFINITIONS_1_3,
} as const;

const DEFINITIONS_BY_DIGEST: ReadonlyMap<string, ProfileDefinition> = new Map(
  [...PROFILE_DEFINITIONS, ...PROFILE_DEFINITIONS_1_3].map((definition) => [
    definition.definition_digest,
    definition,
  ]),
);

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === "string" && (PROFILE_IDS as readonly string[]).includes(value);
}

/**
 * Which profile definition set an operation protocol resolves. Protocol
 * 1.0–1.2 predate the versioned split, so they keep resolving the 1.1
 * definitions; unknown versions fail closed.
 */
export function profileDefinitionVersionForProtocol(
  protocolVersion: string,
): ProfileDefinitionProtocolVersion {
  switch (protocolVersion) {
    case "1.0.0":
    case PROTOCOL_1_1_VERSION:
    case "1.2.0":
      return PROTOCOL_1_1_VERSION;
    case PROTOCOL_1_3_VERSION:
      return PROTOCOL_1_3_VERSION;
    default:
      throw new ProfileRegistryError(`unsupported protocol version: ${protocolVersion}`);
  }
}

/** Fail-closed versioned lookup: unknown tiers are rejected, never mapped to Lite. */
export function profileDefinitionForProtocol(
  profileId: ProfileId,
  protocolVersion: typeof PROTOCOL_1_1_VERSION,
): ProfileDefinitionV11;
export function profileDefinitionForProtocol(
  profileId: ProfileId,
  protocolVersion: typeof PROTOCOL_1_3_VERSION,
): ProfileDefinitionV13;
export function profileDefinitionForProtocol(
  profileId: string,
  protocolVersion: ProfileDefinitionProtocolVersion,
): ProfileDefinition;
export function profileDefinitionForProtocol(
  profileId: string,
  protocolVersion: ProfileDefinitionProtocolVersion,
): ProfileDefinition {
  const definitions: readonly ProfileDefinition[] = DEFINITIONS_BY_VERSION[protocolVersion];
  const definition = definitions.find((entry) => entry.profile_id === profileId);
  if (definition === undefined) {
    throw new ProfileRegistryError(`${profileId} (protocol ${protocolVersion})`);
  }
  return definition;
}

/** Fail-closed lookup on the legacy 1.1 registry: unknown tiers are rejected. */
export function profileDefinition(profileId: string): ProfileDefinitionV11 {
  const definition = PROFILE_DEFINITIONS.find((entry) => entry.profile_id === profileId);
  if (definition === undefined) {
    throw new ProfileRegistryError(profileId);
  }
  return definition;
}

/**
 * Digest-addressed lookup across every definition version. ProjectProfileRecord
 * assertions resolve the referenced `profile_definition_digest` here instead of
 * comparing against the newest definition, so a 1.3 registry never invalidates
 * records that pinned a 1.1 definition.
 */
export function profileDefinitionByDigest(digest: string): ProfileDefinition {
  const definition = DEFINITIONS_BY_DIGEST.get(digest);
  if (definition === undefined) {
    throw new ProfileRegistryError(`unknown profile definition digest: ${digest}`);
  }
  return definition;
}

/** Tier ordering lite < standard < governed for upgrade/downgrade decisions. */
export function profileRank(profileId: ProfileId): number {
  return PROFILE_IDS.indexOf(profileId);
}
