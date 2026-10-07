import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  contentDigest,
  createTrustedProviderRegistry,
  type TrustedProviderDefinition,
} from "@universal-harness-internal/core";

import { assembleModelProviders, readProjectRuntimeConfig } from "../src/index.js";

const roots: string[] = [];

function projectWithConfig(config: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-model-providers-")));
  roots.push(root);
  mkdirSync(join(root, ".harness"));
  writeFileSync(join(root, ".harness", "runtime.json"), JSON.stringify(config), "utf8");
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const DEEPSeek_ENTRY = {
  provider_id: "deepseek",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-pro",
  api_key_env: "DEEPSEEK_API_KEY",
  env_allowlist: ["DEEPSEEK_API_KEY"],
  timeout_ms: 60000,
  slots: ["grounded_synthesis", "design_review"],
};

const TYPESAFE_TRUST = {
  provider_ref: "typesafe",
  provider_identity: "provider_typesafe",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  api_key_env: "TYPESAFE_API_KEY",
  env_allowlist: ["TYPESAFE_API_KEY"],
  allowed_consumers: ["managed_model"],
} satisfies TrustedProviderDefinition;

const JEV_REFERENCE = {
  provider_ref: "typesafe",
  model: "jev-1.13.0",
  slots: ["impact_advisory"],
  is_default: false,
  timeout_ms: 30_000,
};

function registryFor(
  entry: Pick<typeof DEEPSeek_ENTRY, "provider_id" | "endpoint" | "api_key_env" | "env_allowlist">,
) {
  return createTrustedProviderRegistry([
    {
      provider_ref: entry.provider_id,
      provider_identity: `provider_${entry.provider_id}`,
      endpoint: entry.endpoint,
      api_key_env: entry.api_key_env,
      env_allowlist: entry.env_allowlist,
      allowed_consumers: ["managed_model"],
    },
  ]);
}

describe("model_providers configuration", () => {
  it("parses a v2 model provider declaration", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [DEEPSeek_ENTRY],
    });
    const config = readProjectRuntimeConfig(root);
    expect(config.model_providers).toHaveLength(1);
    expect(config.model_providers?.[0]).toMatchObject({
      provider_id: "deepseek",
      model: "deepseek-v4-pro",
      api_key_env: "DEEPSEEK_API_KEY",
      is_default: false,
      slots: ["design_review", "grounded_synthesis"],
    });
  });

  it("omits the section when undeclared", () => {
    const root = projectWithConfig({ runtime_config_version: 2, gates: [] });
    expect(readProjectRuntimeConfig(root).model_providers).toBeUndefined();
  });

  it("rejects model_providers on runtime_config_version 1", () => {
    const root = projectWithConfig({
      runtime_config_version: 1,
      gates: [],
      model_providers: [DEEPSeek_ENTRY],
    });
    expect(() => readProjectRuntimeConfig(root)).toThrowError(/requires runtime_config_version 2/u);
  });

  it("rejects an entry whose env_allowlist misses the api_key_env", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [{ ...DEEPSeek_ENTRY, env_allowlist: ["OTHER_KEY"] }],
    });
    expect(() => readProjectRuntimeConfig(root)).toThrowError(/env_allowlist/u);
  });

  it("rejects duplicate provider ids and duplicate defaults", () => {
    const duplicateId = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [DEEPSeek_ENTRY, DEEPSeek_ENTRY],
    });
    expect(() => readProjectRuntimeConfig(duplicateId)).toThrowError(/declared twice/u);

    const duplicateDefault = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [
        { ...DEEPSeek_ENTRY, default: true },
        { ...DEEPSeek_ENTRY, provider_id: "backup", default: true },
      ],
    });
    expect(() => readProjectRuntimeConfig(duplicateDefault)).toThrowError(/default/u);
  });

  it("rejects non-HTTPS endpoints and out-of-range timeouts", () => {
    const insecure = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [{ ...DEEPSeek_ENTRY, endpoint: "http://api.deepseek.com/chat" }],
    });
    expect(() => readProjectRuntimeConfig(insecure)).toThrowError(/endpoint/u);

    const slow = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [{ ...DEEPSeek_ENTRY, timeout_ms: 300001 }],
    });
    expect(() => readProjectRuntimeConfig(slow)).toThrowError(/timeout_ms/u);
  });
});

describe("assembleModelProviders", () => {
  it("retains the pre-Jev DeepSeek configuration digest", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [DEEPSeek_ENTRY],
    });
    const provider = assembleModelProviders(readProjectRuntimeConfig(root), {
      environment: {},
    }).resolve("design_review");
    expect(provider?.provider_config.config_digest).toBe(
      "9952fc53d6946fe71116bb409211027fecf55bdcd2786020cb93b32108b7317a",
    );
  });

  it.each([
    {
      name: "model alias",
      entry: { ...JEV_REFERENCE, model: "jev-latest" },
      trust: TYPESAFE_TRUST,
    },
    {
      name: "model version",
      entry: { ...JEV_REFERENCE, model: "jev-1.12.0" },
      trust: TYPESAFE_TRUST,
    },
    {
      name: "provider alias",
      entry: { ...JEV_REFERENCE, provider_ref: "another" },
      trust: { ...TYPESAFE_TRUST, provider_ref: "another" },
    },
    {
      name: "endpoint",
      entry: JEV_REFERENCE,
      trust: { ...TYPESAFE_TRUST, endpoint: "https://attacker.example/systemone" },
    },
    {
      name: "key environment",
      entry: JEV_REFERENCE,
      trust: { ...TYPESAFE_TRUST, api_key_env: "OTHER_KEY", env_allowlist: ["OTHER_KEY"] },
    },
    {
      name: "extra environment",
      entry: JEV_REFERENCE,
      trust: { ...TYPESAFE_TRUST, env_allowlist: ["TYPESAFE_API_KEY", "OTHER_KEY"] },
    },
    {
      name: "identity",
      entry: JEV_REFERENCE,
      trust: { ...TYPESAFE_TRUST, provider_identity: "unrelated_provider" },
    },
    {
      name: "loopback policy",
      entry: JEV_REFERENCE,
      trust: { ...TYPESAFE_TRUST, allow_loopback_http: true },
    },
  ])("rejects Jev $name drift before reading environment or HTTP", ({ entry, trust }) => {
    const root = projectWithConfig({
      runtime_config_version: 3,
      gates: [],
      model_providers: [entry],
    });
    const readKey = vi.fn(() => "must-not-be-read");
    const environment = Object.defineProperty({}, "TYPESAFE_API_KEY", { get: readKey });
    const fetchMock = vi.fn<typeof fetch>();
    expect(() =>
      assembleModelProviders(readProjectRuntimeConfig(root), {
        environment,
        fetch: fetchMock,
        registry: createTrustedProviderRegistry([trust]),
      }),
    ).toThrow(/Jev/u);
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects legacy inline Jev configuration even when it matches host trust", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [
        {
          provider_id: "typesafe",
          endpoint: TYPESAFE_TRUST.endpoint,
          api_key_env: TYPESAFE_TRUST.api_key_env,
          env_allowlist: TYPESAFE_TRUST.env_allowlist,
          model: JEV_REFERENCE.model,
          slots: JEV_REFERENCE.slots,
          timeout_ms: JEV_REFERENCE.timeout_ms,
        },
      ],
    });
    expect(() =>
      assembleModelProviders(readProjectRuntimeConfig(root), {
        environment: {},
        registry: createTrustedProviderRegistry([TYPESAFE_TRUST]),
      }),
    ).toThrow(/Jev.*V3/u);
  });

  it.each([
    { ...JEV_REFERENCE, is_default: true },
    { ...JEV_REFERENCE, slots: ["design_review"] },
    { ...JEV_REFERENCE, slots: [] },
    { ...JEV_REFERENCE, slots: ["impact_advisory", "prd_proposal"] },
  ])("refuses invalid Jev scope before touching environment: %j", (entry) => {
    const root = projectWithConfig({
      runtime_config_version: 3,
      gates: [],
      model_providers: [entry],
    });
    const readKey = vi.fn(() => "secret");
    const fetchMock = vi.fn<typeof fetch>();
    expect(() =>
      assembleModelProviders(readProjectRuntimeConfig(root), {
        environment: Object.defineProperty({}, "TYPESAFE_API_KEY", { get: readKey }),
        fetch: fetchMock,
      }),
    ).toThrow(/Jev/u);
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate explicit impact bindings rather than silently selecting one", () => {
    const root = projectWithConfig({
      runtime_config_version: 3,
      gates: [],
      model_providers: [
        JEV_REFERENCE,
        {
          provider_ref: "deepseek",
          model: "deepseek-v4-flash",
          slots: ["impact_advisory"],
          is_default: false,
          timeout_ms: 60000,
        },
      ],
    });
    expect(() =>
      assembleModelProviders(readProjectRuntimeConfig(root), { environment: {} }),
    ).toThrow(/registered twice/u);
  });

  it.each(["endpoint", "api_key_env", "env_allowlist", "prompt_version"])(
    "rejects repository-controlled Jev %s configuration",
    (field) => {
      const root = projectWithConfig({
        runtime_config_version: 3,
        gates: [],
        model_providers: [{ ...JEV_REFERENCE, [field]: "repository override" }],
      });
      expect(() => readProjectRuntimeConfig(root)).toThrow();
    },
  );

  it("pins Jev transport/projection/mapping/limits in configuration digests without secret values", () => {
    const root = projectWithConfig({
      runtime_config_version: 3,
      gates: [],
      model_providers: [JEV_REFERENCE],
    });
    const registry = createTrustedProviderRegistry([TYPESAFE_TRUST]);
    const trusted = registry.resolve({ provider_ref: "typesafe", consumer: "managed_model" });
    const oldShape = contentDigest({
      provider_ref: trusted.provider_ref,
      provider_identity: trusted.provider_identity,
      endpoint: trusted.endpoint,
      model: JEV_REFERENCE.model,
      timeout_ms: JEV_REFERENCE.timeout_ms,
      slots: JEV_REFERENCE.slots,
      is_default: false,
      trusted_policy_digest: trusted.policy_digest,
    });
    const expected = contentDigest({
      provider_config_digest: oldShape,
      transport_version: "jev-systemone.v1",
      projection_version: "jev-impact-projection.v1",
      mapping_version: "jev-impact-mapping.v1",
      limits_version: "jev-impact-limits.v1",
    });
    for (const fakeValue of ["first-fake-secret", "different-fake-secret"]) {
      const resolved = assembleModelProviders(readProjectRuntimeConfig(root), {
        registry,
        environment: { TYPESAFE_API_KEY: fakeValue },
      }).resolve("impact_advisory");
      expect(resolved?.provider_config.config_digest).toBe(expected);
      expect(resolved?.provider_config.config_digest).not.toBe(oldShape);
      expect(JSON.stringify(resolved)).not.toContain(fakeValue);
    }
  });

  it("resolves explicit V3 Jev impact separately while preserving the original default provider", () => {
    const root = projectWithConfig({
      runtime_config_version: 3,
      gates: [],
      model_providers: [
        {
          provider_ref: "deepseek",
          model: "deepseek-v4-flash",
          slots: [],
          is_default: true,
          timeout_ms: 60_000,
        },
        {
          provider_ref: "typesafe",
          model: "jev-1.13.0",
          slots: ["impact_advisory"],
          is_default: false,
          timeout_ms: 30_000,
        },
      ],
    });
    const fetchMock = vi.fn<typeof fetch>();
    const resolver = assembleModelProviders(readProjectRuntimeConfig(root), {
      fetch: fetchMock,
      environment: {},
      registry: createTrustedProviderRegistry([
        {
          provider_ref: "deepseek",
          provider_identity: "provider_deepseek",
          endpoint: "https://api.deepseek.com/chat/completions",
          api_key_env: "DEEPSEEK_API_KEY",
          env_allowlist: ["DEEPSEEK_API_KEY"],
          allowed_consumers: ["managed_model"],
        },
        {
          provider_ref: "typesafe",
          provider_identity: "provider_typesafe",
          endpoint: "https://api.typesafe.ai/v1/systemone",
          api_key_env: "TYPESAFE_API_KEY",
          env_allowlist: ["TYPESAFE_API_KEY"],
          allowed_consumers: ["managed_model"],
        },
      ]),
    });
    const impact = resolver.resolve("impact_advisory");
    expect(impact).toMatchObject({
      kind: "jev_impact",
      bind: expect.any(Function),
      provider_config: { provider_identity: "provider_typesafe" },
    });
    const review = resolver.resolve("design_review");
    expect(review).toMatchObject({
      kind: "managed_prompt",
      provider: { invoke: expect.any(Function) },
      provider_config: { provider_identity: "provider_deepseek" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves v3 references only through host trust and never reads repository secret fields", async () => {
    const root = projectWithConfig({
      runtime_config_version: 3,
      gates: [],
      model_providers: [
        {
          provider_ref: "deepseek",
          model: "deepseek-v4-flash",
          slots: ["prd_proposal"],
          is_default: true,
          timeout_ms: 60_000,
        },
      ],
    });
    const fetchCalls: string[] = [];
    const resolver = assembleModelProviders(readProjectRuntimeConfig(root), {
      registry: createTrustedProviderRegistry([
        {
          provider_ref: "deepseek",
          provider_identity: "provider_deepseek",
          endpoint: "https://api.deepseek.com/chat/completions",
          api_key_env: "TRUSTED_DEEPSEEK_KEY",
          env_allowlist: ["TRUSTED_DEEPSEEK_KEY"],
          allowed_consumers: ["managed_model"],
        },
      ]),
      environment: {
        TRUSTED_DEEPSEEK_KEY: "trusted-value",
        AWS_SECRET_ACCESS_KEY: "repository-must-not-select-this",
      },
      fetch: (url, init) => {
        fetchCalls.push(String(url));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer trusted-value");
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
            status: 200,
          }),
        );
      },
    });

    const resolved = resolver.resolve("prd_proposal");
    if (resolved?.kind !== "managed_prompt")
      throw new Error("expected the original managed prompt provider");
    await resolved.provider.invoke({
      messages: [],
      output_schema_id: "test",
      timeout_ms: 1_000,
      max_output_bytes: 1_024,
    });
    expect(fetchCalls).toEqual(["https://api.deepseek.com/chat/completions"]);
    expect(JSON.stringify(resolved)).not.toContain("repository-must-not-select-this");
  });

  it("rejects a repository declaration that does not match the trusted provider policy", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [
        {
          ...DEEPSeek_ENTRY,
          endpoint: "https://attacker.example/v1/chat/completions",
          api_key_env: "AWS_SECRET_ACCESS_KEY",
          env_allowlist: ["AWS_SECRET_ACCESS_KEY"],
        },
      ],
    });

    expect(() =>
      assembleModelProviders(readProjectRuntimeConfig(root), {
        environment: { AWS_SECRET_ACCESS_KEY: "must-not-be-read" },
        registry: registryFor(DEEPSeek_ENTRY),
      }),
    ).toThrowError(/trusted provider policy/u);
  });

  it("binds the complete endpoint and credential policy into the config digest", () => {
    const firstRoot = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [DEEPSeek_ENTRY],
    });
    const secondEntry = {
      ...DEEPSeek_ENTRY,
      endpoint: "https://api.deepseek.com/v2/chat/completions",
      api_key_env: "DEEPSEEK_V2_API_KEY",
      env_allowlist: ["DEEPSEEK_V2_API_KEY"],
    };
    const secondRoot = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [secondEntry],
    });
    const first = assembleModelProviders(readProjectRuntimeConfig(firstRoot), {
      registry: registryFor(DEEPSeek_ENTRY),
    }).resolve("grounded_synthesis");
    const second = assembleModelProviders(readProjectRuntimeConfig(secondRoot), {
      registry: registryFor(secondEntry),
    }).resolve("grounded_synthesis");

    expect(first?.provider_config.config_digest).not.toBe(second?.provider_config.config_digest);
  });

  it("resolves listed slots to a working provider without exposing the key", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [DEEPSeek_ENTRY],
    });
    const resolver = assembleModelProviders(readProjectRuntimeConfig(root), {
      environment: { DEEPSEEK_API_KEY: "sk-live" },
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer sk-live");
        expect(String(url)).toBe(DEEPSeek_ENTRY.endpoint);
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
            status: 200,
          }),
        );
      },
    });
    const resolved = resolver.resolve("grounded_synthesis");
    expect(resolved).toBeDefined();
    expect(resolved?.provider_config.provider_identity).toBe("provider_deepseek");
    expect(resolved?.provider_config.config_digest).toMatch(/^[0-9a-f]{64}$/u);
    // The declared endpoint timeout becomes the managed invocation budget.
    expect(resolved?.budget).toEqual({
      timeout_ms: DEEPSeek_ENTRY.timeout_ms,
      max_output_bytes: 256 * 1024,
    });
    if (resolved?.kind !== "managed_prompt")
      throw new Error("expected the original managed prompt provider");
    const outcome = await resolved.provider.invoke({
      messages: [],
      output_schema_id: "x",
      timeout_ms: 1000,
      max_output_bytes: 1024,
    });
    expect(outcome).toEqual({ ok: true, content: "{}" });
    // Slots without coverage stay unresolved; the runner keeps failing closed.
    expect(resolver.resolve("impact_advisory")).toBeUndefined();
  });

  it("honours the default registration for unlisted slots", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [{ ...DEEPSeek_ENTRY, slots: [], default: true }],
    });
    const resolver = assembleModelProviders(readProjectRuntimeConfig(root), {
      environment: { DEEPSEEK_API_KEY: "sk-live" },
      fetch: () => Promise.reject(new Error("unused")),
    });
    expect(resolver.resolve("feedback_analysis")?.provider_config.provider_identity).toBe(
      "provider_deepseek",
    );
  });
});
