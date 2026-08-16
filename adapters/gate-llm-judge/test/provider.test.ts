import { describe, expect, it } from "vitest";

import { LLM_JUDGE_EXTENSION_KEY, runLlmJudge } from "../src/index.js";

const config = {
  endpoint: "https://judge.example.com/v1/chat/completions",
  model: "reviewer-v1",
  api_key_env: "JUDGE_KEY",
  env_allowlist: ["JUDGE_KEY"],
  timeout_ms: 1000,
  prompt_version: "v1",
  seed: 7,
} as const;

const bundle = {
  baseline_commit: "a".repeat(40),
  source_commit: "b".repeat(40),
  code_digest: "c".repeat(64),
  changed_paths: ["src/app.ts"],
  diff: "+export const value = 1;",
  acceptance_criteria: ["value is exported"],
  related_records: [],
  deterministic_gates: [],
  line_counts: { "src/app.ts": 1 },
} as const;

function providerResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe("LLM judge provider", () => {
  it.each([
    ["pass", true, 0],
    ["warn", false, 2],
    ["fail", false, 1],
  ] as const)("normalizes a %s verdict into a gate result", async (verdict, passed, exitCode) => {
    const output = await runLlmJudge(config, bundle, {
      ambientEnvironment: { JUDGE_KEY: "secret-value" },
      fetch: () =>
        Promise.resolve(
          providerResponse(
            JSON.stringify({
              verdict,
              confidence: 0.8,
              reasons:
                verdict === "pass"
                  ? []
                  : [{ code: "review", message: "inspect value", path: "src/app.ts", line: 1 }],
            }),
          ),
        ),
    });

    expect(output).toMatchObject({ passed, exit_code: exitCode });
    expect(output.extensions[LLM_JUDGE_EXTENSION_KEY]).toMatchObject({
      model: "reviewer-v1",
      prompt_version: "v1",
      review_bundle_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      normalized_response: { verdict },
      error_kind: null,
    });
    expect(JSON.stringify(output)).not.toContain("secret-value");
  });

  it.each([
    ["invalid response", () => Promise.resolve(providerResponse("not-json")), "invalid_response"],
    [
      "timeout",
      () => Promise.reject(Object.assign(new Error("timed out"), { name: "AbortError" })),
      "timeout",
    ],
  ])("fails closed on %s", async (_name, fetchImpl, errorKind) => {
    const output = await runLlmJudge(config, bundle, {
      ambientEnvironment: { JUDGE_KEY: "secret-value" },
      fetch: fetchImpl,
    });
    expect(output.passed).toBe(false);
    expect(output.extensions[LLM_JUDGE_EXTENSION_KEY].error_kind).toBe(errorKind);
  });

  it("reports bundle_too_large without calling the provider", async () => {
    let calls = 0;
    const output = await runLlmJudge(
      config,
      { ...bundle, diff: "x".repeat(256 * 1024) },
      {
        ambientEnvironment: { JUDGE_KEY: "secret-value" },
        fetch: () => {
          calls += 1;
          return Promise.reject(new Error("must not call provider"));
        },
      },
    );
    expect(output).toMatchObject({ passed: false, exit_code: 1 });
    expect(output.extensions[LLM_JUDGE_EXTENSION_KEY].error_kind).toBe("bundle_too_large");
    expect(calls).toBe(0);
  });
});
