import { describe, expect, it } from "vitest";

import { TrustedProviderError, createTrustedProviderRegistry } from "../../src/index.js";

const provider = {
  provider_ref: "deepseek",
  provider_identity: "provider_deepseek",
  endpoint: "https://api.deepseek.com/chat/completions",
  api_key_env: "DEEPSEEK_API_KEY",
  env_allowlist: ["SECONDARY_KEY", "DEEPSEEK_API_KEY"],
  allowed_consumers: ["llm_judge", "managed_model"] as const,
};

describe("trusted provider registry", () => {
  it("resolves an exact provider and consumer from host-owned policy", () => {
    const registry = createTrustedProviderRegistry([provider]);

    expect(registry.resolve({ provider_ref: "deepseek", consumer: "llm_judge" })).toMatchObject({
      provider_ref: "deepseek",
      provider_identity: "provider_deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      api_key_env: "DEEPSEEK_API_KEY",
      env_allowlist: ["DEEPSEEK_API_KEY", "SECONDARY_KEY"],
      allow_loopback_http: false,
      policy_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("rejects duplicate provider references at construction", () => {
    expect(() => createTrustedProviderRegistry([provider, provider])).toThrowError(
      expect.objectContaining({
        name: "TrustedProviderError",
        code: "duplicate_provider_ref",
      }),
    );
  });

  it("rejects unknown providers and forbidden consumers", () => {
    const registry = createTrustedProviderRegistry([
      { ...provider, allowed_consumers: ["managed_model"] },
    ]);

    expect(() =>
      registry.resolve({ provider_ref: "missing", consumer: "managed_model" }),
    ).toThrowError(
      expect.objectContaining<Partial<TrustedProviderError>>({ code: "provider_not_found" }),
    );
    expect(() =>
      registry.resolve({ provider_ref: "deepseek", consumer: "llm_judge" }),
    ).toThrowError(
      expect.objectContaining<Partial<TrustedProviderError>>({ code: "consumer_forbidden" }),
    );
  });

  it("derives a stable policy digest from canonical URL and set ordering", () => {
    const first = createTrustedProviderRegistry([provider]).resolve({
      provider_ref: "deepseek",
      consumer: "managed_model",
    });
    const second = createTrustedProviderRegistry([
      {
        ...provider,
        endpoint: "https://API.DEEPSEEK.COM:443/chat/completions",
        env_allowlist: [...provider.env_allowlist].reverse(),
        allowed_consumers: [...provider.allowed_consumers].reverse(),
      },
    ]).resolve({ provider_ref: "deepseek", consumer: "managed_model" });

    expect(second.policy_digest).toBe(first.policy_digest);
  });
});
