import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTrustedProviderRegistry } from "@universal-harness-internal/core";

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
    await resolved?.provider.invoke({
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
    const outcome = await resolved!.provider.invoke({
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
