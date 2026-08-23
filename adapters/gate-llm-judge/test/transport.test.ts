import { describe, expect, it } from "vitest";

import {
  JudgeTransportError,
  MAX_PROVIDER_RESPONSE_BYTES,
  requestJudgeCompletion,
  validateJudgeEndpoint,
} from "../src/index.js";

describe("OpenAI-compatible judge transport", () => {
  it("cancels a streaming body immediately on overflow without full buffering", async () => {
    let cancelled = false;
    let arrayBufferCalled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES - 8));
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = {
      ok: true,
      status: 200,
      body,
      arrayBuffer: () => {
        arrayBufferCalled = true;
        return Promise.reject(new Error("arrayBuffer must not be used"));
      },
    } as unknown as Response;

    const result = await requestJudgeCompletion(
      {
        endpoint: "https://api.example.com/v1/chat/completions",
        model: "judge-model",
        api_key_env: "JUDGE_KEY",
        env_allowlist: ["JUDGE_KEY"],
        timeout_ms: 1000,
      },
      {},
      {
        ambientEnvironment: { JUDGE_KEY: "secret" },
        fetch: () => Promise.resolve(response),
      },
    );

    expect(result).toMatchObject({ ok: false, error_kind: "invalid_provider_response" });
    expect(cancelled).toBe(true);
    expect(arrayBufferCalled).toBe(false);
  });

  it("allows HTTPS, rejects credentialed/private endpoints and limits HTTP to test loopback", () => {
    expect(validateJudgeEndpoint("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com",
    );
    for (const endpoint of [
      "http://api.example.com/v1/chat/completions",
      "https://127.0.0.1/v1/chat/completions",
      "https://user:pass@api.example.com/v1/chat/completions",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect(() => validateJudgeEndpoint(endpoint)).toThrowError(JudgeTransportError);
    }
    expect(
      validateJudgeEndpoint("http://127.0.0.1:43123/v1/chat/completions", {
        allowLoopbackHttp: true,
      }),
    ).toBe("http://127.0.0.1:43123");
  });

  it("uses only an allowlisted key and retries 429/5xx at most twice", async () => {
    const statuses = [429, 503, 200];
    const calls: Array<{ authorization: string | null; body: unknown }> = [];
    const result = await requestJudgeCompletion(
      {
        endpoint: "https://api.example.com/v1/chat/completions",
        model: "judge-model",
        api_key_env: "JUDGE_KEY",
        env_allowlist: ["JUDGE_KEY"],
        timeout_ms: 1000,
      },
      { messages: [{ role: "system", content: "review" }], temperature: 0 },
      {
        ambientEnvironment: { JUDGE_KEY: "super-secret", AMBIENT_SECRET: "must-not-leak" },
        sleep: () => Promise.resolve(),
        fetch: (_url, init) => {
          const status = statuses.shift() ?? 500;
          const headers = new Headers(init?.headers);
          calls.push({ authorization: headers.get("authorization"), body: init?.body });
          return Promise.resolve(
            new Response(
              status === 200
                ? JSON.stringify({
                    choices: [
                      { message: { content: '{"verdict":"pass","confidence":1,"reasons":[]}' } },
                    ],
                  })
                : "temporary",
              { status },
            ),
          );
        },
      },
    );

    expect(result).toMatchObject({ ok: true, attempts: 3, retry_count: 2 });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.authorization === "Bearer super-secret")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("AMBIENT_SECRET");
  });

  it("refuses a key not present in the explicit env allowlist", async () => {
    await expect(
      requestJudgeCompletion(
        {
          endpoint: "https://api.example.com/v1/chat/completions",
          model: "judge-model",
          api_key_env: "JUDGE_KEY",
          env_allowlist: [],
          timeout_ms: 1000,
        },
        {},
        { ambientEnvironment: { JUDGE_KEY: "secret" } },
      ),
    ).rejects.toMatchObject<Partial<JudgeTransportError>>({ kind: "secret_not_allowlisted" });
  });

  it("blocks a hostname that DNS resolves to a private address before fetch", async () => {
    let called = false;
    await expect(
      requestJudgeCompletion(
        {
          endpoint: "https://judge.example.com/v1/chat/completions",
          model: "judge-model",
          api_key_env: "JUDGE_KEY",
          env_allowlist: ["JUDGE_KEY"],
          timeout_ms: 1000,
        },
        {},
        {
          ambientEnvironment: { JUDGE_KEY: "secret" },
          resolveHostname: () => Promise.resolve(["10.0.0.8"]),
          fetch: () => {
            called = true;
            return Promise.reject(new Error("must not run"));
          },
        },
      ),
    ).rejects.toMatchObject<Partial<JudgeTransportError>>({ kind: "ssrf_blocked" });
    expect(called).toBe(false);
  });

  it.each([
    [429, "rate_limited"],
    [503, "provider_5xx"],
  ] as const)("fails with a typed outcome after three HTTP %s attempts", async (status, kind) => {
    let calls = 0;
    const result = await requestJudgeCompletion(
      {
        endpoint: "https://api.example.com/v1/chat/completions",
        model: "judge-model",
        api_key_env: "JUDGE_KEY",
        env_allowlist: ["JUDGE_KEY"],
        timeout_ms: 1000,
      },
      {},
      {
        ambientEnvironment: { JUDGE_KEY: "secret" },
        sleep: () => Promise.resolve(),
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response("temporary", { status }));
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      error_kind: kind,
      attempts: 3,
      retry_count: 2,
      endpoint_origin: "https://api.example.com",
    });
    expect(calls).toBe(3);
  });
});
