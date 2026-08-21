import type { ManagedModelProviderPort } from "./managed-runner.js";
import type { ModelBackedProviderConfig } from "./capture-adapters.js";

/**
 * Per-slot provider resolution (managed model layer). Each DAG node's model
 * slot — `grounded_synthesis`, `design_review`, `impact_advisory`, … — resolves
 * to exactly one registered provider; a single default registration covers
 * every unlisted slot. Slots without coverage resolve to undefined so the
 * runner's existing `provider_required` fail-closed path stays authoritative.
 */

export interface ManagedProviderRegistration {
  readonly provider: ManagedModelProviderPort;
  readonly provider_config: ModelBackedProviderConfig;
  /** Slot or port identifiers this registration serves. */
  readonly slots: readonly string[];
  readonly is_default: boolean;
}

export interface ResolvedManagedProvider {
  readonly provider: ManagedModelProviderPort;
  readonly provider_config: ModelBackedProviderConfig;
}

export interface ManagedProviderResolver {
  resolve(slot: string): ResolvedManagedProvider | undefined;
}

export class ProviderRegistryError extends Error {
  readonly kind = "provider_registry_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

export function createManagedProviderResolver(
  registrations: readonly ManagedProviderRegistration[],
): ManagedProviderResolver {
  const bySlot = new Map<string, ResolvedManagedProvider>();
  let fallback: ResolvedManagedProvider | undefined;
  for (const registration of registrations) {
    const resolved: ResolvedManagedProvider = {
      provider: registration.provider,
      provider_config: registration.provider_config,
    };
    for (const slot of registration.slots) {
      if (bySlot.has(slot)) {
        throw new ProviderRegistryError(`model slot ${slot} is registered twice`);
      }
      bySlot.set(slot, resolved);
    }
    if (registration.is_default) {
      if (fallback !== undefined) {
        throw new ProviderRegistryError("only one default model provider is allowed");
      }
      fallback = resolved;
    }
  }
  return {
    resolve: (slot: string) => bySlot.get(slot) ?? fallback,
  };
}
