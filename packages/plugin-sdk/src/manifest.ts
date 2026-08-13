import {
  contentDigest,
  PLUGIN_KINDS,
  validateSchema,
  type PluginManifest,
} from "@universal-harness-internal/core";

import {
  AGENT_CONTROL_LEVELS,
  AGENT_RESUME_SEMANTICS,
  AGENT_TRAJECTORY_VISIBILITIES,
  type AgentProviderManifest,
} from "./agent.js";
import { checkProtocolCompatibility } from "./compatibility.js";

/**
 * Plugin Capability Manifest (design 13, acceptance `PluginCapabilityManifest`).
 * The manifest is the pre-execution contract: protocol version, plugin kind,
 * declared capabilities and resource needs. A manifest that is structurally
 * invalid, protocol-incompatible, or that cannot back its claims fails here --
 * before the plugin ever runs (plan Task 24, step 2).
 *
 * Validation reuses the authoritative core schema (`plugin` registry key), so
 * SDK-level checks can never drift from the persisted record contract.
 */

export const PLUGIN_MANIFEST_ERROR_KINDS = [
  "invalid_manifest",
  "incompatible_protocol",
  "undeclared_capability",
  "undeclared_resource",
  "unproven_control_profile",
] as const;

export type PluginManifestErrorKind = (typeof PLUGIN_MANIFEST_ERROR_KINDS)[number];

export class PluginManifestError extends Error {
  readonly kind: PluginManifestErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: PluginManifestErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PluginManifestError";
    this.kind = kind;
    if (details !== undefined) this.details = details;
  }
}

export type { PluginManifest };

export type PluginKind = PluginManifest["kind"];

export { PLUGIN_KINDS };

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new PluginManifestError("invalid_manifest", message, details);
}

/**
 * Assert the declared protocol version can execute against this host. The
 * check runs before schema validation so an incompatible major version is
 * reported as `incompatible_protocol`, not drowned in pattern errors.
 */
export function assertCompatibleProtocol(version: string): void {
  const compatibility = checkProtocolCompatibility(version);
  if (!compatibility.compatible) {
    throw new PluginManifestError("incompatible_protocol", compatibility.reason, {
      protocol_version: compatibility.protocol_version,
      host_version: compatibility.host_version,
    });
  }
}

/**
 * Validate an untrusted manifest against the authoritative plugin schema. Any
 * violation is a typed error thrown before execution; the return value is the
 * narrowed manifest.
 */
export function validatePluginManifest(raw: unknown): PluginManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid("a plugin manifest must be an object");
  }
  const candidate = raw as { protocol_version?: unknown };
  if (typeof candidate.protocol_version === "string") {
    assertCompatibleProtocol(candidate.protocol_version);
  }
  const result = validateSchema("plugin", raw);
  if (!result.valid) {
    invalid(
      `plugin manifest failed schema validation: ${result.errors
        .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
        .join("; ")}`,
      { issues: result.errors },
    );
  }
  return raw as PluginManifest;
}

/** Content digest of a validated manifest; binds approvals and audits to it. */
export function pluginManifestDigest(manifest: PluginManifest): string {
  return contentDigest(manifest);
}

/** What a host requires a plugin to have declared before execution. */
export interface PluginRequirements {
  readonly capabilities?: readonly string[];
  readonly resources?: readonly string[];
}

/**
 * Pre-execution check that the manifest declares everything the host is about
 * to rely on. A missing declaration is a typed refusal -- the host must never
 * grant a capability the plugin did not declare, and a plugin must never run
 * with resource needs it kept hidden.
 */
export function assertManifestSatisfies(
  manifest: PluginManifest,
  requirements: PluginRequirements,
): void {
  const capabilities = new Set(manifest.capabilities);
  const missingCapabilities = (requirements.capabilities ?? []).filter(
    (capability) => !capabilities.has(capability),
  );
  if (missingCapabilities.length > 0) {
    throw new PluginManifestError(
      "undeclared_capability",
      `plugin ${manifest.name} did not declare required capabilities: ${missingCapabilities.join(", ")}`,
      { missing: missingCapabilities },
    );
  }
  const resources = new Set(manifest.resources);
  const missingResources = (requirements.resources ?? []).filter(
    (resource) => !resources.has(resource),
  );
  if (missingResources.length > 0) {
    throw new PluginManifestError(
      "undeclared_resource",
      `plugin ${manifest.name} did not declare required resources: ${missingResources.join(", ")}`,
      { missing: missingResources },
    );
  }
}

function readEnumClaim<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(`agent control profile ${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * Validate an agent plugin's control-profile claim (design 13.2). Structural
 * violations are `invalid_manifest`; a claim the profile itself contradicts --
 * a `managed` adapter without full trajectory visibility -- is
 * `unproven_control_profile`, because the Harness would otherwise report
 * coverage it cannot have.
 */
export function validateAgentControlProfileClaim(raw: unknown): AgentProviderManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid("an agent control profile claim must be an object");
  }
  const claim = raw as AgentProviderManifest;
  if (typeof claim.provider !== "string" || claim.provider.trim() === "") {
    invalid("agent control profile provider must be a non-empty string");
  }
  const control = readEnumClaim(claim.control, AGENT_CONTROL_LEVELS, "control");
  const trajectory = readEnumClaim(
    claim.trajectory_visibility,
    AGENT_TRAJECTORY_VISIBILITIES,
    "trajectory_visibility",
  );
  readEnumClaim(claim.resume_semantics, AGENT_RESUME_SEMANTICS, "resume_semantics");
  if (typeof claim.usage_metering !== "boolean") {
    invalid("agent control profile usage_metering must be a boolean");
  }
  if (typeof claim.side_effect_interception !== "boolean") {
    invalid("agent control profile side_effect_interception must be a boolean");
  }
  if (control === "managed" && trajectory !== "full") {
    throw new PluginManifestError(
      "unproven_control_profile",
      "a managed control claim requires full trajectory visibility; the Harness cannot own a loop it cannot see",
      { control, trajectory_visibility: trajectory },
    );
  }
  return claim;
}
