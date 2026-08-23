import { describe, expect, it, vi } from "vitest";

import type { ModelPortFailure } from "@universal-harness-internal/core";

import { compilePrompt, type CompiledPrompt } from "../../src/model/prompt-compiler.js";
import {
  planModelInvocation,
  transitionModelInvocation,
  type ManagedInvocationBinding,
} from "../../src/model/invocation-records.js";
import {
  appendModelInvocationRecord,
  readModelInvocationRecords,
} from "../../src/model/invocation-store.js";
import {
  managedInvocationCacheKey,
  runManagedInvocation,
  type ManagedModelProviderPort,
  type RunManagedInvocationParams,
} from "../../src/model/managed-runner.js";
import { makeTempDir } from "../bootstrap/helpers.js";
import {
  TEST_PROMPT_PORT_ID,
  TEST_PROMPT_VERSION,
  createTestRegistry,
  testInputBundle,
} from "./fixtures.js";

function testBinding(): ManagedInvocationBinding {
  const contract = createTestRegistry().contracts[0]!;
  return {
    provider_identity: "provider_anthropic",
    config_digest: "0".repeat(64),
    prompt_contract_id: contract.contract_id,
    prompt_contract_version: contract.version,
    prompt_contract_digest: contract.contract_digest,
    output_schema_digest: contract.output_schema_digest,
    budget_profile: "capture-standard",
  };
}

function compiled(): CompiledPrompt {
  const result = compilePrompt({
    registry: createTestRegistry(),
    selector: { port_id: TEST_PROMPT_PORT_ID, prompt_version: TEST_PROMPT_VERSION },
    profile: "standard",
    input_bundle: testInputBundle(),
  });
  if (!result.ok) throw new Error("expected ok");
  return result.compiled;
}

const VALID_OUTPUT = JSON.stringify({
  purpose: "approval_brief",
  schema_version: "approval-brief.v1",
  bundle_digest: "a".repeat(64),
  changes: [],
  risks: [],
  tradeoffs: [],
  open_questions: [],
});

function providerReturning(response: string): ManagedModelProviderPort {
  return { invoke: vi.fn(async () => ({ ok: true as const, content: response })) };
}

function params(
  root: string,
  overrides: Partial<RunManagedInvocationParams> = {},
): RunManagedInvocationParams {
  return {
    projectRoot: root,
    identity: {
      invocation_id: "invocation_01K1TEST",
      conversation_id: "conversation_01K1TEST",
      run_id: "run_01K1TEST",
    },
    port_id: TEST_PROMPT_PORT_ID,
    binding: testBinding(),
    output_schema_id: "approval-brief-output",
    compiled: compiled(),
    budget: { timeout_ms: 5_000, max_output_bytes: 64 * 1024 },
    ...overrides,
  };
}

describe("managed runner provider boundary", () => {
  it("passes only compiled messages and limits to the provider — never raw text or paths", async () => {
    const root = makeTempDir("harness-runner-");
    const provider = providerReturning(VALID_OUTPUT);
    const outcome = await runManagedInvocation(params(root, { provider }));
    expect(outcome.status).toBe("validated");
    const invoke = provider.invoke as ReturnType<typeof vi.fn>;
    const request = invoke.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual([
      "max_output_bytes",
      "messages",
      "output_schema_id",
      "signal",
      "timeout_ms",
    ]);
    expect(request["signal"]).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(request)).not.toContain(root);
  });

  it("persists planned+started — pinning every digest — before any provider call", async () => {
    const root = makeTempDir("harness-runner-");
    let statesAtCallTime: string[] = [];
    const provider: ManagedModelProviderPort = {
      invoke: async () => {
        statesAtCallTime = readModelInvocationRecords(root).map((record) => record.state);
        return { ok: true, content: VALID_OUTPUT };
      },
    };
    const outcome = await runManagedInvocation(params(root, { provider }));
    expect(outcome.status).toBe("validated");
    expect(statesAtCallTime).toEqual(["planned", "started"]);
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated"]);
  });

  it("records provider token usage and Harness-measured duration", async () => {
    const root = makeTempDir("harness-runner-usage-");
    let now = 1_000;
    const provider: ManagedModelProviderPort = {
      invoke: async () => {
        now = 1_125;
        return { ok: true, content: VALID_OUTPUT, usage: { tokens: 37 } };
      },
    };
    const outcome = await runManagedInvocation(params(root, { provider, clock: () => now }));
    expect(outcome.status).toBe("validated");
    expect(readModelInvocationRecords(root).at(-1)?.usage).toEqual({
      tokens: 37,
      duration_ms: 125,
    });
  });

  it("records a typed provider failure on the invocation record", async () => {
    const root = makeTempDir("harness-runner-");
    const failure: ModelPortFailure = {
      code: "provider_unavailable",
      summary: "endpoint down",
      retryable: true,
    };
    const provider: ManagedModelProviderPort = {
      invoke: async () => ({ ok: false, failure }),
    };
    const outcome = await runManagedInvocation(params(root, { provider }));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.failure.code).toBe("provider_unavailable");
    const latest = readModelInvocationRecords(root).at(-1)!;
    expect(latest.state).toBe("failed");
    expect(latest.failure?.code).toBe("provider_unavailable");
  });

  it("fails closed with provider_required when the provider is missing", async () => {
    const root = makeTempDir("harness-runner-");
    const outcome = await runManagedInvocation(params(root));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.failure.code).toBe("provider_required");
    expect(outcome.failure.retryable).toBe(false);
  });

  it("maps timeouts, oversize outputs and invalid JSON to the exact codes", async () => {
    const slowRoot = makeTempDir("harness-runner-");
    const slow: ManagedModelProviderPort = {
      invoke: () => new Promise(() => {}),
    };
    const slowOutcome = await runManagedInvocation(
      params(slowRoot, { provider: slow, budget: { timeout_ms: 25, max_output_bytes: 1024 } }),
    );
    expect(slowOutcome.status).toBe("failed");
    if (slowOutcome.status === "failed") expect(slowOutcome.failure.code).toBe("timeout");

    const bigRoot = makeTempDir("harness-runner-");
    const bigOutcome = await runManagedInvocation(
      params(bigRoot, {
        provider: providerReturning("x".repeat(2048)),
        budget: { timeout_ms: 5_000, max_output_bytes: 1024 },
      }),
    );
    expect(bigOutcome.status).toBe("failed");
    if (bigOutcome.status === "failed") expect(bigOutcome.failure.code).toBe("budget_exhausted");

    const badRoot = makeTempDir("harness-runner-");
    const badOutcome = await runManagedInvocation(
      params(badRoot, { provider: providerReturning("not json") }),
    );
    expect(badOutcome.status).toBe("failed");
    if (badOutcome.status === "failed") expect(badOutcome.failure.code).toBe("invalid_output");
  });
});

describe("managed runner replay, cache and independence", () => {
  it("replays a consumed invocation without calling the provider again", async () => {
    const root = makeTempDir("harness-runner-");
    const provider = providerReturning(VALID_OUTPUT);
    const first = await runManagedInvocation(params(root, { provider }));
    expect(first.status).toBe("validated");
    const validated = readModelInvocationRecords(root).at(-1)!;
    appendModelInvocationRecord(root, transitionModelInvocation(validated, "consumed"));

    const second = await runManagedInvocation(params(root, { provider }));
    expect(second.status).toBe("replayed");
    expect(provider.invoke as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("does not allow caller input to force a validated result to run twice", async () => {
    const root = makeTempDir("harness-runner-");
    const provider = providerReturning(VALID_OUTPUT);
    const first = await runManagedInvocation(params(root, { provider }));
    expect(first.status).toBe("validated");

    // Runtime inputs may still contain the removed pre-result-artifact option.
    // It must be ignored: immutable validated evidence is always replayed.
    const legacyInput = {
      ...params(root, { provider }),
      force_fresh: true,
    } as RunManagedInvocationParams;
    const second = await runManagedInvocation(legacyInput);

    expect(second.status).toBe("replayed");
    expect(provider.invoke as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("resumes a crash at started as a new attempt without rewriting history", async () => {
    const root = makeTempDir("harness-runner-");
    const compiledPrompt = compiled();
    const binding = testBinding();
    const attempt1 = planModelInvocation({
      invocation_id: "invocation_01K1TEST",
      conversation_id: "conversation_01K1TEST",
      run_id: "run_01K1TEST",
      attempt: 1,
      port_id: TEST_PROMPT_PORT_ID,
      binding,
      output_schema_id: "approval-brief-output",
      profile_overlay_digest: compiledPrompt.profile_overlay_digest,
      policy_overlay_digest: compiledPrompt.policy_overlay_digest,
      input_bundle_digest: compiledPrompt.input_bundle_digest,
      compiled_prompt_digest: compiledPrompt.compiled_prompt_digest,
      cache_key: managedInvocationCacheKey(params(root)),
    });
    appendModelInvocationRecord(root, attempt1);
    appendModelInvocationRecord(root, transitionModelInvocation(attempt1, "started"));

    const provider = providerReturning(VALID_OUTPUT);
    const outcome = await runManagedInvocation(params(root, { provider }));
    expect(outcome.status).toBe("validated");
    const records = readModelInvocationRecords(root);
    expect(Math.max(...records.map((record) => record.attempt))).toBe(2);
    expect(records.filter((record) => record.attempt === 1)).toHaveLength(2);
  });

  it("invalidates only the unconsumed result when the pinned digests drift", async () => {
    const root = makeTempDir("harness-runner-");
    const provider = providerReturning(VALID_OUTPUT);
    const first = await runManagedInvocation(params(root, { provider }));
    expect(first.status).toBe("validated");

    // Same invocation identity, recompiled prompt (e.g. contract amendment).
    const drifted = await runManagedInvocation(
      params(root, {
        provider,
        compiled: { ...compiled(), compiled_prompt_digest: "7".repeat(64) },
      }),
    );
    expect(drifted.status).toBe("validated");
    const records = readModelInvocationRecords(root);
    const invalidated = records.filter((record) => record.state === "invalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]!.attempt).toBe(1);
    // Attempt 1's full history is preserved.
    expect(records.filter((record) => record.attempt === 1).map((r) => r.state)).toEqual([
      "planned",
      "started",
      "completed",
      "validated",
      "invalidated",
    ]);
  });

  it("serves a cache hit only for the identical cache key", async () => {
    const root = makeTempDir("harness-runner-");
    const provider = providerReturning(VALID_OUTPUT);
    const first = await runManagedInvocation(params(root, { provider }));
    expect(first.status).toBe("validated");

    const cached = await runManagedInvocation(
      params(root, {
        provider,
        identity: {
          invocation_id: "invocation_01K1OTHER",
          conversation_id: "conversation_01K1OTHER",
          run_id: "run_01K1OTHER",
        },
      }),
    );
    expect(cached.status).toBe("replayed");
    expect(provider.invoke as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("fails independence_violation when a conversation is reused across contracts", async () => {
    const root = makeTempDir("harness-runner-");
    const provider = providerReturning(VALID_OUTPUT);
    const first = await runManagedInvocation(params(root, { provider }));
    expect(first.status).toBe("validated");

    const tampered = await runManagedInvocation(
      params(root, {
        provider,
        binding: { ...testBinding(), prompt_contract_digest: "9".repeat(64) },
        compiled: {
          ...compiled(),
          contract_digest: "9".repeat(64),
          compiled_prompt_digest: "8".repeat(64),
        },
        identity: {
          invocation_id: "invocation_01K1TAMPER",
          conversation_id: "conversation_01K1TEST",
          run_id: "run_01K1TAMPER",
        },
      }),
    );
    expect(tampered.status).toBe("failed");
    if (tampered.status === "failed") {
      expect(tampered.failure.code).toBe("independence_violation");
    }
  });
});
