import { describe, expect, it } from "vitest";

import {
  createOpenAiCompatManagedProvider,
  type OpenAiCompatProviderConfig,
  type OpenAiCompatProviderDependencies,
} from "../../src/model/openai-compat-provider.js";
import type { ManagedModelProviderRequest } from "../../src/model/managed-runner.js";

const CONFIG: OpenAiCompatProviderConfig = {
  provider_identity: "provider_deepseek",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-pro",
  api_key_env: "DEEPSEEK_API_KEY",
  env_allowlist: ["DEEPSEEK_API_KEY"],
};

const REQUEST: ManagedModelProviderRequest = {
  messages: [
    { role: "system", partition: "role_instruction", content: "be terse", digest: "a".repeat(64) },
    { role: "user", partition: "untrusted_input", content: "hello", digest: "b".repeat(64) },
  ],
  output_schema_id: "project-discovery-result.v1",
  timeout_ms: 5_000,
  max_output_bytes: 64 * 1024,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatCompletion(content: string): unknown {
  return { choices: [{ message: { role: "assistant", content } }] };
}

function depsWith(
  overrides: Partial<OpenAiCompatProviderDependencies>,
): OpenAiCompatProviderDependencies {
  return {
    ambientEnvironment: { DEEPSEEK_API_KEY: "sk-test" },
    resolveHostname: () => Promise.resolve(["203.0.113.10"]),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

describe("openai-compat managed provider", () => {
  it("posts bearer auth and role/content messages, returning the completion text", async () => {
    let seen: { url: unknown; init: RequestInit | undefined } | undefined;
    const provider = createOpenAiCompatManagedProvider(
      CONFIG,
      depsWith({
        fetch: (url, init) => {
          seen = { url, init };
          return Promise.resolve(jsonResponse(chatCompletion('{"ok":true}')));
        },
      }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result).toEqual({ ok: true, content: '{"ok":true}' });
    expect(seen?.url).toBe(CONFIG.endpoint);
    const headers = new Headers(seen?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    const body = JSON.parse(String(seen?.init?.body)) as {
      model: string;
      messages: readonly { role: string; content: string }[];
    };
    expect(body.model).toBe("deepseek-v4-pro");
    // Only role/content cross the wire; partitions and digests stay local.
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
    ]);
  });

  it("fails closed with policy_denied when the key env is not allowlisted", async () => {
    const provider = createOpenAiCompatManagedProvider(
      { ...CONFIG, env_allowlist: ["SOME_OTHER_KEY"] },
      depsWith({ fetch: () => Promise.reject(new Error("must not be called")) }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("policy_denied");
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.summary).toContain("DEEPSEEK_API_KEY");
  });

  it("fails closed with provider_unavailable when the key is absent", async () => {
    const provider = createOpenAiCompatManagedProvider(
      CONFIG,
      depsWith({
        ambientEnvironment: {},
        fetch: () => Promise.reject(new Error("must not be called")),
      }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("provider_unavailable");
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.summary).not.toContain("sk-test");
  });

  it("rejects non-HTTPS endpoints before any network access", async () => {
    const provider = createOpenAiCompatManagedProvider(
      { ...CONFIG, endpoint: "http://api.deepseek.com/chat/completions" },
      depsWith({ fetch: () => Promise.reject(new Error("must not be called")) }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("policy_denied");
  });

  it("blocks endpoints whose DNS resolves to a private address", async () => {
    const provider = createOpenAiCompatManagedProvider(
      CONFIG,
      depsWith({
        resolveHostname: () => Promise.resolve(["10.0.0.8"]),
        fetch: () => Promise.reject(new Error("must not be called")),
      }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("policy_denied");
    expect(result.failure.summary).toContain("private");
  });

  it("retries 429 once and then succeeds", async () => {
    let calls = 0;
    const provider = createOpenAiCompatManagedProvider(
      CONFIG,
      depsWith({
        fetch: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1
              ? jsonResponse({ error: "slow down" }, 429)
              : jsonResponse(chatCompletion("done")),
          );
        },
      }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result).toEqual({ ok: true, content: "done" });
    expect(calls).toBe(2);
  });

  it("maps exhausted 5xx retries to retryable provider_unavailable", async () => {
    let calls = 0;
    const provider = createOpenAiCompatManagedProvider(
      CONFIG,
      depsWith({
        fetch: () => {
          calls += 1;
          return Promise.resolve(jsonResponse({ error: "boom" }, 500));
        },
      }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("provider_unavailable");
    expect(result.failure.retryable).toBe(true);
    expect(calls).toBe(3);
  });

  it("maps other HTTP errors to non-retryable provider_unavailable", async () => {
    const provider = createOpenAiCompatManagedProvider(
      CONFIG,
      depsWith({ fetch: () => Promise.resolve(jsonResponse({ error: "bad" }, 400)) }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("provider_unavailable");
    expect(result.failure.retryable).toBe(false);
  });

  it("maps aborts to retryable timeout", async () => {
    const provider = createOpenAiCompatManagedProvider(
      CONFIG,
      depsWith({
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      }),
    );
    const result = await provider.invoke({ ...REQUEST, timeout_ms: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("timeout");
    expect(result.failure.retryable).toBe(true);
  });

  it("maps a non-JSON response body to invalid_output", async () => {
    const provider = createOpenAiCompatManagedProvider(
      CONFIG,
      depsWith({
        fetch: () => Promise.resolve(new Response("not json", { status: 200 })),
      }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_output");
    expect(result.failure.retryable).toBe(false);
  });

  it("maps a completion without text content to invalid_output", async () => {
    const provider = createOpenAiCompatManagedProvider(
      CONFIG,
      depsWith({ fetch: () => Promise.resolve(jsonResponse({ choices: [] })) }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_output");
  });

  it("maps an oversized response to budget_exhausted", async () => {
    const provider = createOpenAiCompatManagedProvider(
      { ...CONFIG, max_response_bytes: 16 },
      depsWith({
        fetch: () => Promise.resolve(jsonResponse(chatCompletion("x".repeat(64)))),
      }),
    );
    const result = await provider.invoke(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("budget_exhausted");
    expect(result.failure.retryable).toBe(false);
  });
});
