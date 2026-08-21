import { contentDigest } from "@universal-harness-internal/core";
import {
  createManagedProviderResolver,
  createOpenAiCompatManagedProvider,
  type ManagedProviderRegistration,
  type ManagedProviderResolver,
} from "@universal-harness-internal/runtime";

import type { ProjectModelProviderConfig, ProjectRuntimeConfig } from "./project-runtime-config.js";

/**
 * Assembly seam for the managed model layer: turns the committed
 * `model_providers` declarations into per-slot provider registrations. The
 * resolver is injected wherever ModelBackedAdapterDeps are built; slots with
 * no coverage resolve to undefined so the runner keeps failing closed with
 * `provider_required`. API keys are never read here — only the env var names
 * travel into the provider instances.
 */

export interface AssembleModelProvidersDependencies {
  readonly fetch?: typeof fetch;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Digest-stable, secret-free view of one provider declaration. */
function providerConfigDigest(config: ProjectModelProviderConfig): string {
  return contentDigest({
    endpoint_origin: new URL(config.endpoint).origin,
    model: config.model,
    timeout_ms: config.timeout_ms,
    slots: config.slots,
    is_default: config.is_default,
  });
}

export function assembleModelProviders(
  config: ProjectRuntimeConfig,
  deps: AssembleModelProvidersDependencies = {},
): ManagedProviderResolver {
  const registrations: ManagedProviderRegistration[] = (config.model_providers ?? []).map(
    (entry) => ({
      provider: createOpenAiCompatManagedProvider(
        {
          provider_identity: `provider_${entry.provider_id}`,
          endpoint: entry.endpoint,
          model: entry.model,
          api_key_env: entry.api_key_env,
          env_allowlist: entry.env_allowlist,
          ...(entry.allow_loopback_http === undefined
            ? {}
            : { allow_loopback_http: entry.allow_loopback_http }),
        },
        {
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(deps.environment === undefined ? {} : { ambientEnvironment: deps.environment }),
        },
      ),
      provider_config: {
        provider_identity: `provider_${entry.provider_id}`,
        config_digest: providerConfigDigest(entry),
        budget_profile: "managed-standard",
      },
      slots: entry.slots,
      is_default: entry.is_default,
    }),
  );
  return createManagedProviderResolver(registrations);
}
