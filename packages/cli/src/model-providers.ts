import { contentDigest } from "@universal-harness-internal/core";
import {
  createManagedProviderResolver,
  createOpenAiCompatManagedProvider,
  DEFAULT_BUDGET,
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
  /**
   * Host-owned trust policy. Project runtime configuration is untrusted input:
   * it may select a provider id, model, slots and budget, but it cannot choose
   * which ambient secret is sent to which network endpoint. Embedders can
   * replace the built-in policies through this seam without placing policy in
   * the managed repository.
   */
  readonly trustedPolicies?: readonly TrustedModelProviderPolicy[];
}

export interface TrustedModelProviderPolicy {
  readonly provider_id: string;
  readonly endpoint: string;
  readonly api_key_env: string;
  readonly env_allowlist: readonly string[];
  /** Test/host-only; a repository declaration cannot grant this capability. */
  readonly allow_loopback_http?: boolean;
}

export class TrustedModelProviderPolicyError extends Error {
  readonly kind = "trusted_model_provider_policy" as const;

  constructor(message: string) {
    super(message);
    this.name = "TrustedModelProviderPolicyError";
  }
}

/**
 * Minimal host trust root shipped by the standalone CLI. Additional providers
 * must be supplied by a trusted host integration, never by the project being
 * executed. This keeps a cloned repository from redirecting an ambient secret
 * merely by editing `.harness/runtime.json`.
 */
export const BUILTIN_TRUSTED_MODEL_PROVIDER_POLICIES: readonly TrustedModelProviderPolicy[] = [
  {
    provider_id: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    api_key_env: "DEEPSEEK_API_KEY",
    env_allowlist: ["DEEPSEEK_API_KEY"],
  },
];

function canonicalEndpoint(value: string): string {
  return new URL(value).toString();
}

function normalizedNames(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function policyDigest(policy: TrustedModelProviderPolicy): string {
  return contentDigest({
    provider_id: policy.provider_id,
    endpoint: canonicalEndpoint(policy.endpoint),
    api_key_env: policy.api_key_env,
    env_allowlist: normalizedNames(policy.env_allowlist),
    allow_loopback_http: policy.allow_loopback_http ?? false,
  });
}

function trustedPolicyFor(
  entry: ProjectModelProviderConfig,
  policies: readonly TrustedModelProviderPolicy[],
): TrustedModelProviderPolicy {
  const matches = policies.filter((policy) => policy.provider_id === entry.provider_id);
  if (matches.length !== 1) {
    throw new TrustedModelProviderPolicyError(
      `trusted provider policy requires exactly one host policy for ${entry.provider_id}`,
    );
  }
  const policy = matches[0] as TrustedModelProviderPolicy;
  const projectNames = normalizedNames(entry.env_allowlist);
  const policyNames = normalizedNames(policy.env_allowlist);
  const matchesPolicy =
    canonicalEndpoint(entry.endpoint) === canonicalEndpoint(policy.endpoint) &&
    entry.api_key_env === policy.api_key_env &&
    projectNames.length === policyNames.length &&
    projectNames.every((name, index) => name === policyNames[index]) &&
    (entry.allow_loopback_http ?? false) === (policy.allow_loopback_http ?? false);
  if (!matchesPolicy) {
    throw new TrustedModelProviderPolicyError(
      `repository declaration for ${entry.provider_id} does not match its trusted provider policy`,
    );
  }
  return policy;
}

/** Digest-stable, secret-free view of one provider declaration. */
function providerConfigDigest(
  config: ProjectModelProviderConfig,
  policy: TrustedModelProviderPolicy,
): string {
  return contentDigest({
    endpoint: canonicalEndpoint(policy.endpoint),
    model: config.model,
    api_key_env: policy.api_key_env,
    env_allowlist: normalizedNames(policy.env_allowlist),
    trusted_policy_digest: policyDigest(policy),
    timeout_ms: config.timeout_ms,
    slots: config.slots,
    is_default: config.is_default,
  });
}

export function assembleModelProviders(
  config: ProjectRuntimeConfig,
  deps: AssembleModelProvidersDependencies = {},
): ManagedProviderResolver {
  const policies = deps.trustedPolicies ?? BUILTIN_TRUSTED_MODEL_PROVIDER_POLICIES;
  const registrations: ManagedProviderRegistration[] = (config.model_providers ?? []).map(
    (entry) => {
      const policy = trustedPolicyFor(entry, policies);
      return {
        provider: createOpenAiCompatManagedProvider(
          {
            provider_identity: `provider_${entry.provider_id}`,
            endpoint: policy.endpoint,
            model: entry.model,
            api_key_env: policy.api_key_env,
            env_allowlist: policy.env_allowlist,
            ...(policy.allow_loopback_http === undefined
              ? {}
              : { allow_loopback_http: policy.allow_loopback_http }),
          },
          {
            ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
            ...(deps.environment === undefined ? {} : { ambientEnvironment: deps.environment }),
          },
        ),
        provider_config: {
          provider_identity: `provider_${entry.provider_id}`,
          config_digest: providerConfigDigest(entry, policy),
          budget_profile: "managed-standard",
        },
        slots: entry.slots,
        is_default: entry.is_default,
        // The declared endpoint timeout doubles as the managed invocation
        // budget; without it the runner's built-in 60s default would preempt
        // slow real-model calls long before the provider gives up.
        budget: { timeout_ms: entry.timeout_ms, max_output_bytes: DEFAULT_BUDGET.max_output_bytes },
      };
    },
  );
  return createManagedProviderResolver(registrations);
}
