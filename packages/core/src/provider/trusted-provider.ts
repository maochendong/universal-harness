import { canonicalStringSet } from "../identity/canonical-set.js";
import { contentDigest } from "../identity/digest.js";

export type TrustedProviderConsumer = "managed_model" | "llm_judge";

export interface TrustedProviderDefinition {
  readonly provider_ref: string;
  readonly provider_identity: string;
  readonly endpoint: string;
  readonly api_key_env: string;
  readonly env_allowlist: readonly string[];
  readonly allowed_consumers: readonly TrustedProviderConsumer[];
  readonly allow_loopback_http?: boolean;
}

export interface ResolvedTrustedProvider {
  readonly provider_ref: string;
  readonly provider_identity: string;
  readonly endpoint: string;
  readonly api_key_env: string;
  readonly env_allowlist: readonly string[];
  readonly allow_loopback_http: boolean;
  readonly policy_digest: string;
}

export interface TrustedProviderRegistry {
  resolve(input: {
    readonly provider_ref: string;
    readonly consumer: TrustedProviderConsumer;
  }): ResolvedTrustedProvider;
  matchLegacy(input: {
    readonly endpoint: string;
    readonly api_key_env: string;
    readonly env_allowlist: readonly string[];
    readonly allow_loopback_http: boolean;
    readonly consumer: TrustedProviderConsumer;
  }): ResolvedTrustedProvider;
}

export type TrustedProviderErrorCode =
  | "duplicate_provider_ref"
  | "invalid_provider_definition"
  | "provider_not_found"
  | "consumer_forbidden"
  | "legacy_policy_mismatch";

export class TrustedProviderError extends Error {
  readonly code: TrustedProviderErrorCode;

  constructor(code: TrustedProviderErrorCode, message: string) {
    super(message);
    this.name = "TrustedProviderError";
    this.code = code;
  }
}

interface StoredTrustedProvider extends ResolvedTrustedProvider {
  readonly allowed_consumers: readonly TrustedProviderConsumer[];
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TrustedProviderError(
      "invalid_provider_definition",
      `${field} must be a non-empty string`,
    );
  }
  return normalized;
}

function canonicalEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TrustedProviderError(
      "invalid_provider_definition",
      "endpoint must be an absolute URL",
    );
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new TrustedProviderError(
      "invalid_provider_definition",
      "endpoint must use http or https",
    );
  }
  endpoint.hash = "";
  return endpoint.toString();
}

function normalizeProvider(definition: TrustedProviderDefinition): StoredTrustedProvider {
  const provider_ref = requiredText(definition.provider_ref, "provider_ref");
  const provider_identity = requiredText(definition.provider_identity, "provider_identity");
  const endpoint = canonicalEndpoint(definition.endpoint);
  const api_key_env = requiredText(definition.api_key_env, "api_key_env");
  const env_allowlist = canonicalStringSet(definition.env_allowlist);
  const allowed_consumers = canonicalStringSet(
    definition.allowed_consumers,
  ) as TrustedProviderConsumer[];
  const allow_loopback_http = definition.allow_loopback_http ?? false;

  if (!env_allowlist.includes(api_key_env)) {
    throw new TrustedProviderError(
      "invalid_provider_definition",
      "api_key_env must be present in env_allowlist",
    );
  }
  if (allowed_consumers.length === 0) {
    throw new TrustedProviderError(
      "invalid_provider_definition",
      "allowed_consumers must not be empty",
    );
  }
  if (
    allowed_consumers.some((consumer) => consumer !== "managed_model" && consumer !== "llm_judge")
  ) {
    throw new TrustedProviderError(
      "invalid_provider_definition",
      "allowed_consumers contains an unsupported consumer",
    );
  }

  const policy_digest = contentDigest({
    provider_ref,
    provider_identity,
    endpoint,
    api_key_env,
    env_allowlist,
    allowed_consumers,
    allow_loopback_http,
  });

  return Object.freeze({
    provider_ref,
    provider_identity,
    endpoint,
    api_key_env,
    env_allowlist: Object.freeze(env_allowlist),
    allowed_consumers: Object.freeze(allowed_consumers),
    allow_loopback_http,
    policy_digest,
  });
}

export function createTrustedProviderRegistry(
  definitions: readonly TrustedProviderDefinition[],
): TrustedProviderRegistry {
  const providers = new Map<string, StoredTrustedProvider>();
  for (const definition of definitions) {
    const provider = normalizeProvider(definition);
    if (providers.has(provider.provider_ref)) {
      throw new TrustedProviderError(
        "duplicate_provider_ref",
        `duplicate trusted provider reference: ${provider.provider_ref}`,
      );
    }
    providers.set(provider.provider_ref, provider);
  }

  return Object.freeze({
    resolve(input: {
      readonly provider_ref: string;
      readonly consumer: TrustedProviderConsumer;
    }): ResolvedTrustedProvider {
      const provider = providers.get(input.provider_ref);
      if (!provider) {
        throw new TrustedProviderError(
          "provider_not_found",
          `trusted provider not found: ${input.provider_ref}`,
        );
      }
      if (!provider.allowed_consumers.includes(input.consumer)) {
        throw new TrustedProviderError(
          "consumer_forbidden",
          `trusted provider ${input.provider_ref} is not allowed for ${input.consumer}`,
        );
      }
      const { allowed_consumers: allowedConsumers, ...resolved } = provider;
      void allowedConsumers;
      return resolved;
    },
    matchLegacy(input: {
      readonly endpoint: string;
      readonly api_key_env: string;
      readonly env_allowlist: readonly string[];
      readonly allow_loopback_http: boolean;
      readonly consumer: TrustedProviderConsumer;
    }): ResolvedTrustedProvider {
      const endpoint = canonicalEndpoint(input.endpoint);
      const envAllowlist = canonicalStringSet(input.env_allowlist);
      const matches = [...providers.values()].filter(
        (provider) =>
          provider.allowed_consumers.includes(input.consumer) &&
          provider.endpoint === endpoint &&
          provider.api_key_env === input.api_key_env &&
          provider.allow_loopback_http === input.allow_loopback_http &&
          provider.env_allowlist.length === envAllowlist.length &&
          provider.env_allowlist.every((name, index) => name === envAllowlist[index]),
      );
      if (matches.length !== 1) {
        throw new TrustedProviderError(
          "legacy_policy_mismatch",
          "legacy inline provider policy does not uniquely match host trust",
        );
      }
      const { allowed_consumers: allowedConsumers, ...resolved } =
        matches[0] as StoredTrustedProvider;
      void allowedConsumers;
      return resolved;
    },
  });
}
