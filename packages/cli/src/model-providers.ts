import {
  contentDigest,
  createTrustedProviderRegistry,
  TrustedProviderError,
  type ResolvedTrustedProvider,
  type TrustedProviderRegistry,
} from "@universal-harness-internal/core";
import {
  createManagedProviderResolver,
  createJevImpactProviderFactory,
  createOpenAiCompatManagedProvider,
  DEFAULT_BUDGET,
  type ManagedProviderRegistration,
  type ManagedProviderResolver,
} from "@universal-harness-internal/runtime";

import type {
  ProjectModelProviderConfig,
  ProjectModelProviderReference,
  ProjectRuntimeConfig,
} from "./project-runtime-config.js";

export interface AssembleModelProvidersDependencies {
  readonly fetch?: typeof fetch;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Host-owned trust root. It is never loaded from the managed repository. */
  readonly registry?: TrustedProviderRegistry;
}

export class TrustedModelProviderPolicyError extends Error {
  readonly kind = "trusted_model_provider_policy" as const;

  constructor(message: string) {
    super(message);
    this.name = "TrustedModelProviderPolicyError";
  }
}

/** Release-owned default. Embedders may inject a different host registry. */
export const BUILTIN_TRUSTED_PROVIDER_REGISTRY = createTrustedProviderRegistry([
  {
    provider_ref: "deepseek",
    provider_identity: "provider_deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    api_key_env: "DEEPSEEK_API_KEY",
    env_allowlist: ["DEEPSEEK_API_KEY"],
    allowed_consumers: ["managed_model", "llm_judge"],
  },
  {
    provider_ref: "typesafe",
    provider_identity: "provider_typesafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    api_key_env: "TYPESAFE_API_KEY",
    env_allowlist: ["TYPESAFE_API_KEY"],
    allowed_consumers: ["managed_model"],
  },
]);

function canonicalEndpoint(value: string): string {
  return new URL(value).toString();
}

function normalizedNames(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function assertLegacyExactMatch(
  entry: ProjectModelProviderConfig,
  trusted: ResolvedTrustedProvider,
): void {
  const projectNames = normalizedNames(entry.env_allowlist);
  const trustedNames = normalizedNames(trusted.env_allowlist);
  const matches =
    canonicalEndpoint(entry.endpoint) === trusted.endpoint &&
    entry.api_key_env === trusted.api_key_env &&
    projectNames.length === trustedNames.length &&
    projectNames.every((name, index) => name === trustedNames[index]) &&
    (entry.allow_loopback_http ?? false) === trusted.allow_loopback_http;
  if (!matches) {
    throw new TrustedModelProviderPolicyError(
      `legacy repository declaration for ${entry.provider_id} does not exactly match its trusted provider policy`,
    );
  }
}

function resolveTrusted(
  registry: TrustedProviderRegistry,
  entry: ProjectModelProviderConfig | ProjectModelProviderReference,
): ResolvedTrustedProvider {
  const providerRef = "provider_ref" in entry ? entry.provider_ref : entry.provider_id;
  try {
    return registry.resolve({ provider_ref: providerRef, consumer: "managed_model" });
  } catch (error) {
    if (error instanceof TrustedProviderError) {
      throw new TrustedModelProviderPolicyError(error.message);
    }
    throw error;
  }
}

function providerConfigDigest(
  entry: ProjectModelProviderConfig | ProjectModelProviderReference,
  trusted: ResolvedTrustedProvider,
): string {
  return contentDigest({
    provider_ref: trusted.provider_ref,
    provider_identity: trusted.provider_identity,
    endpoint: trusted.endpoint,
    model: entry.model,
    timeout_ms: entry.timeout_ms,
    slots: normalizedNames(entry.slots),
    is_default: entry.is_default,
    trusted_policy_digest: trusted.policy_digest,
  });
}

function usesJev(
  entry: ProjectModelProviderConfig | ProjectModelProviderReference,
  trusted: ResolvedTrustedProvider,
): boolean {
  return (
    trusted.provider_ref === "typesafe" ||
    trusted.provider_identity === "provider_typesafe" ||
    trusted.endpoint === "https://api.typesafe.ai/v1/systemone" ||
    entry.model.startsWith("jev")
  );
}

function assertJevPolicy(
  config: ProjectRuntimeConfig,
  entry: ProjectModelProviderConfig | ProjectModelProviderReference,
  trusted: ResolvedTrustedProvider,
): void {
  if (config.runtime_config_version !== 3 || !("provider_ref" in entry)) {
    throw new TrustedModelProviderPolicyError(
      "Jev requires V3 provider references; legacy inline configuration is unsupported",
    );
  }
  if (
    entry.provider_ref !== "typesafe" ||
    entry.model !== "jev-1.13.0" ||
    trusted.provider_ref !== "typesafe" ||
    trusted.provider_identity !== "provider_typesafe" ||
    trusted.endpoint !== "https://api.typesafe.ai/v1/systemone" ||
    trusted.api_key_env !== "TYPESAFE_API_KEY" ||
    trusted.env_allowlist.length !== 1 ||
    trusted.env_allowlist[0] !== "TYPESAFE_API_KEY" ||
    trusted.allow_loopback_http
  ) {
    throw new TrustedModelProviderPolicyError(
      "Jev requires the pinned TypeSafe model, endpoint, identity and credential policy; aliases are unsupported",
    );
  }
}

/**
 * Bind untrusted project references to host-owned provider policy. Version 3
 * contributes only provider/model/slot/budget choices. Version 1/2 records are
 * compatibility-only and must exactly match the host resolution before any
 * environment value is read or any network call can be made.
 */
export function assembleModelProviders(
  config: ProjectRuntimeConfig,
  deps: AssembleModelProvidersDependencies = {},
): ManagedProviderResolver {
  const registry = deps.registry ?? BUILTIN_TRUSTED_PROVIDER_REGISTRY;
  const entries = config.model_providers ?? [];
  const registrations: ManagedProviderRegistration[] = entries.map((entry) => {
    const trusted = resolveTrusted(registry, entry);
    const jev = usesJev(entry, trusted);
    if (jev) assertJevPolicy(config, entry, trusted);
    if (config.runtime_config_version === 2) {
      assertLegacyExactMatch(entry as ProjectModelProviderConfig, trusted);
    }
    if (jev) {
      const factory = createJevImpactProviderFactory({
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.environment === undefined ? {} : { ambientEnvironment: deps.environment }),
      });
      return {
        kind: "jev_impact",
        bind: factory.bind,
        provider_config: {
          provider_identity: trusted.provider_identity,
          config_digest: contentDigest({
            provider_config_digest: providerConfigDigest(entry, trusted),
            transport_version: "jev-systemone.v1",
            projection_version: "jev-impact-projection.v1",
            mapping_version: "jev-impact-mapping.v1",
            limits_version: "jev-impact-limits.v1",
          }),
          budget_profile: "managed-standard",
        },
        slots: entry.slots,
        is_default: entry.is_default,
        budget: { timeout_ms: entry.timeout_ms, max_output_bytes: DEFAULT_BUDGET.max_output_bytes },
      };
    }
    return {
      provider: createOpenAiCompatManagedProvider(
        {
          provider_identity: trusted.provider_identity,
          endpoint: trusted.endpoint,
          model: entry.model,
          api_key_env: trusted.api_key_env,
          env_allowlist: trusted.env_allowlist,
          allow_loopback_http: trusted.allow_loopback_http,
        },
        {
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(deps.environment === undefined ? {} : { ambientEnvironment: deps.environment }),
        },
      ),
      provider_config: {
        provider_identity: trusted.provider_identity,
        config_digest: providerConfigDigest(entry, trusted),
        budget_profile: "managed-standard",
      },
      slots: entry.slots,
      is_default: entry.is_default,
      budget: { timeout_ms: entry.timeout_ms, max_output_bytes: DEFAULT_BUDGET.max_output_bytes },
    };
  });
  return createManagedProviderResolver(registrations);
}
