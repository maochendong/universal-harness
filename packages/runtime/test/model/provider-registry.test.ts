import { describe, expect, it, vi } from "vitest";

import type { ManagedModelProviderPort } from "../../src/model/managed-runner.js";
import { createJevImpactProviderFactory } from "../../src/model/jev-impact-provider.js";
import {
  createManagedProviderResolver,
  ProviderRegistryError,
  type ManagedProviderRegistration,
} from "../../src/model/provider-registry.js";

const PROVIDER: ManagedModelProviderPort = {
  invoke: () => Promise.resolve({ ok: true, content: "{}" }),
};

function registration(
  overrides: Partial<Extract<ManagedProviderRegistration, { readonly kind?: "managed_prompt" }>>,
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
  it("normalizes the legacy implementation and isolates a Jev binder to the explicit impact slot", () => {
    const bind = createJevImpactProviderFactory({
      fetch: vi.fn<typeof fetch>(),
      ambientEnvironment: {},
    }).bind;
    const resolver = createManagedProviderResolver([
      registration({ is_default: true }),
      {
        kind: "jev_impact",
        bind,
        provider_config: {
          provider_identity: "provider_typesafe",
          config_digest: "b".repeat(64),
          budget_profile: "managed-standard",
        },
        slots: ["impact_advisory"],
        is_default: false,
      },
    ]);
    expect(resolver.resolve("impact_advisory")).toMatchObject({ kind: "jev_impact", bind });
    expect(resolver.resolve("design_review")).toMatchObject({
      kind: "managed_prompt",
      provider: PROVIDER,
    });
    expect(resolver.resolve("impact_advisory")).not.toHaveProperty("provider");
  });

  it.each([
    { slots: ["impact_advisory"], is_default: true },
    { slots: [], is_default: false },
    ...[
      "design_review",
      "design_proposal",
      "plan_proposal",
      "feedback_analysis",
      "context_enrichment",
      "iteration_narrative",
      "project_discovery",
      "approval_brief",
      "prd_proposal",
      "prd_review",
    ].map((slot) => ({ slots: ["impact_advisory", slot], is_default: false })),
  ])("rejects Jev outside an explicit impact-only registration: %j", (scope) => {
    const bind = createJevImpactProviderFactory({
      fetch: vi.fn<typeof fetch>(),
      ambientEnvironment: {},
    }).bind;
    expect(() =>
      createManagedProviderResolver([
        { kind: "jev_impact", bind, provider_config: registration({}).provider_config, ...scope },
      ]),
    ).toThrow(ProviderRegistryError);
  });

  it("resolves a slot to its registered provider and config", () => {
    const resolver = createManagedProviderResolver([
      registration({ slots: ["grounded_synthesis", "design_review"] }),
    ]);
    const resolved = resolver.resolve("design_review");
    expect(resolved).toMatchObject({ kind: "managed_prompt", provider: PROVIDER });
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
    expect(resolver.resolve("impact_advisory")).toMatchObject({
      kind: "managed_prompt",
      provider: fallback,
    });
    expect(resolver.resolve("design_review")).toMatchObject({
      kind: "managed_prompt",
      provider: PROVIDER,
    });
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
