import { CAPABILITY_IDS, type CapabilityId } from "../schema/profile.js";

/**
 * Generic capability status projection (slim-profiles design 7.5). Every UI,
 * API, projection and verdict distinguishes exactly five generic states;
 * domain modules may define finer states, but the mapping to the generic five
 * is registered here by the owning module (the strict_tdd mapping lands with
 * the TDD state machine in Task 16) — Read API and Dashboard never reinvent
 * it. Anything unknown fails closed.
 */
export const GENERIC_CAPABILITY_STATUSES = [
  "proven",
  "controlled_not_applicable",
  "not_enabled_by_profile",
  "historical_without_proof",
  "invalid_or_incomplete",
] as const;
export type GenericCapabilityStatus = (typeof GENERIC_CAPABILITY_STATUSES)[number];

export interface CapabilityStatusProjection {
  readonly capability_id: CapabilityId;
  readonly generic_status: GenericCapabilityStatus;
  readonly domain_status: string;
  readonly reason?: string;
  readonly binding_ids: readonly string[];
}

/** The interface through which an owning module registers its state mapping. */
export interface DomainStatusMapping {
  readonly capability_id: CapabilityId;
  readonly mappings: Readonly<Record<string, GenericCapabilityStatus>>;
}

export class StatusProjectionError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "StatusProjectionError";
    this.kind = kind;
  }
}

export interface CapabilityStatusProjector {
  project(
    capabilityId: CapabilityId,
    domainStatus: string,
    options?: { readonly reason?: string; readonly binding_ids?: readonly string[] },
  ): CapabilityStatusProjection;
  inactive(capabilityId: CapabilityId): CapabilityStatusProjection;
}

function isGenericStatus(value: string): value is GenericCapabilityStatus {
  return (GENERIC_CAPABILITY_STATUSES as readonly string[]).includes(value);
}

function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}

export function createCapabilityStatusProjector(
  mappings: readonly DomainStatusMapping[],
): CapabilityStatusProjector {
  const registered = new Map<string, Readonly<Record<string, GenericCapabilityStatus>>>();
  for (const mapping of mappings) {
    if (!isCapabilityId(mapping.capability_id)) {
      throw new StatusProjectionError(
        "unknown_capability",
        `status mapping registered for unknown capability: ${String(mapping.capability_id)}`,
      );
    }
    if (registered.has(mapping.capability_id)) {
      throw new StatusProjectionError(
        "duplicate_capability",
        `duplicate status mapping for capability: ${mapping.capability_id}`,
      );
    }
    for (const [domainStatus, genericStatus] of Object.entries(mapping.mappings)) {
      // Fail closed at registration: a generic status outside the slim five
      // can never reach a projection.
      if (!isGenericStatus(genericStatus)) {
        throw new StatusProjectionError(
          "unknown_generic_status",
          `domain status ${domainStatus} maps to unknown generic status: ${String(genericStatus)}`,
        );
      }
    }
    registered.set(mapping.capability_id, mapping.mappings);
  }

  return {
    project(capabilityId, domainStatus, options = {}) {
      const mapping = registered.get(capabilityId);
      if (mapping === undefined) {
        throw new StatusProjectionError(
          "unregistered_capability",
          `no status mapping registered for capability: ${capabilityId}`,
        );
      }
      const genericStatus = mapping[domainStatus];
      if (genericStatus === undefined || !isGenericStatus(genericStatus)) {
        throw new StatusProjectionError(
          "unknown_domain_status",
          `capability ${capabilityId} has no registered mapping for domain status: ${domainStatus}`,
        );
      }
      return {
        capability_id: capabilityId,
        generic_status: genericStatus,
        domain_status: domainStatus,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        binding_ids: options.binding_ids ?? [],
      };
    },
    inactive(capabilityId) {
      return {
        capability_id: capabilityId,
        generic_status: "not_enabled_by_profile",
        domain_status: "not_enabled_by_profile",
        binding_ids: [],
      };
    },
  };
}
