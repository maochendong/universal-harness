import { describe, expect, it } from "vitest";

import type { ManagedModelProviderPort } from "../../src/model/managed-runner.js";
import {
  createManagedProviderResolver,
  ProviderRegistryError,
  type ManagedProviderRegistration,
} from "../../src/model/provider-registry.js";

const PROVIDER: ManagedModelProviderPort = {
  invoke: () => Promise.resolve({ ok: true, content: "{}" }),
};

function registration(
  overrides: Partial<ManagedProviderRegistration>,
): ManagedProviderRegistration {
  return {
    provider: PROVIDER,
    provider_config: {
      provider_identity: "provider_deepseek",
      config_digest: "c".repeat(64),
      budget_profile: "managed-standard",
    },
    slots: [],
    is_default: false,
    ...overrides,
  };
}

describe("managed provider registry", () => {
  it("resolves a slot to its registered provider and config", () => {
    const resolver = createManagedProviderResolver([
      registration({ slots: ["grounded_synthesis", "design_review"] }),
    ]);
    const resolved = resolver.resolve("design_review");
    expect(resolved?.provider).toBe(PROVIDER);
    expect(resolved?.provider_config.provider_identity).toBe("provider_deepseek");
  });

  it("falls back to the default registration for unlisted slots", () => {
    const fallback: ManagedModelProviderPort = {
      invoke: () => Promise.resolve({ ok: true, content: '{"fallback":true}' }),
    };
    const resolver = createManagedProviderResolver([
      registration({ slots: ["design_review"] }),
      registration({
        provider: fallback,
        provider_config: {
          provider_identity: "provider_local",
          config_digest: "d".repeat(64),
          budget_profile: "managed-standard",
        },
        is_default: true,
      }),
    ]);
    expect(resolver.resolve("impact_advisory")?.provider).toBe(fallback);
    expect(resolver.resolve("design_review")?.provider).toBe(PROVIDER);
  });

  it("returns undefined when nothing covers the slot, preserving provider_required", () => {
    const resolver = createManagedProviderResolver([registration({ slots: ["design_review"] })]);
    expect(resolver.resolve("impact_advisory")).toBeUndefined();
  });

  it("rejects two registrations claiming the same slot", () => {
    expect(() =>
      createManagedProviderResolver([
        registration({ slots: ["design_review"] }),
        registration({ slots: ["design_review"] }),
      ]),
    ).toThrowError(ProviderRegistryError);
  });

  it("rejects two default registrations", () => {
    expect(() =>
      createManagedProviderResolver([
        registration({ is_default: true }),
        registration({ is_default: true }),
      ]),
    ).toThrowError(ProviderRegistryError);
  });
});
