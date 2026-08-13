import { describe, expect, it, vi } from "vitest";

import { contentDigest } from "@universal-harness-internal/core";

import { SecretError } from "../../src/secrets/environment-reference.js";
import { ActionIntentJournal, requestDigest } from "../../src/tools/action-intent.js";
import { ToolError, type ToolErrorKind } from "../../src/tools/definition.js";
import { invokeTool, type ToolInvocationRequest } from "../../src/tools/invocation.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { issueGrant, type CapabilityGrant } from "../../src/policy/capability-grant.js";
import { mergePolicyLayers } from "../../src/policy/evaluator.js";
import { externalTool, hangingHandler, okHandler, pureTool } from "./fixtures.js";

/**
 * Three-phase invocation pipeline (design 13.5). Every rejected call fails
 * with a typed ToolError before any side effect: unknown tool, invalid
 * input/output, wrong phase, forbidden resource, parameter bounds, stale
 * approval, quota, missing idempotency key and grant violations. External
 * calls open an Action Intent first and close it completed or uncertain.
 */
const APPROVAL = "d".repeat(64);

function baseRequest(overrides?: Partial<ToolInvocationRequest>): ToolInvocationRequest {
  return {
    intent_id: "intent_01",
    tool: "http_fetch",
    phase: "implementation",
    parameters: { url: "https://example.test/data" },
    ...overrides,
  };
}

function registryWith(definition: Record<string, unknown>, handler = okHandler()): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(definition, handler);
  return registry;
}

async function expectToolError(promise: Promise<unknown>, kind: ToolErrorKind): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).kind).toBe(kind);
    return error as ToolError;
  }
  throw new Error(`expected a ToolError of kind ${kind}`);
}

describe("invokeTool before-phase validation", () => {
  it("rejects unknown tools, including unregistered MCP-style capabilities", async () => {
    const registry = new ToolRegistry();
    await expectToolError(invokeTool(registry, baseRequest()), "unknown_tool");
    await expectToolError(
      invokeTool(registry, baseRequest({ tool: "mcp__github__create_issue" })),
      "unknown_tool",
    );
  });

  it("rejects invalid input before the handler can run", async () => {
    const handler = vi.fn(okHandler());
    const registry = registryWith(pureTool(), handler);
    await expectToolError(
      invokeTool(registry, baseRequest({ parameters: { mode: "fast" } })),
      "invalid_input",
    );
    await expectToolError(
      invokeTool(
        registry,
        baseRequest({ parameters: { url: "https://example.test", smuggled: true } }),
      ),
      "invalid_input",
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects the wrong phase", async () => {
    const registry = registryWith(pureTool());
    await expectToolError(
      invokeTool(registry, baseRequest({ phase: "release" })),
      "phase_not_allowed",
    );
  });

  it("rejects resources outside the declared scope", async () => {
    const scoped = registryWith(pureTool({ resource_patterns: ["issue:*"] }));
    const request = baseRequest({ resource: "issue:42" });
    const evidence = await invokeTool(scoped, request);
    expect(evidence.output).toEqual({ status: "ok" });
    await expectToolError(
      invokeTool(scoped, baseRequest({ resource: "repo:settings" })),
      "resource_not_allowed",
    );
    await expectToolError(invokeTool(scoped, baseRequest()), "resource_not_allowed");
    const unscoped = registryWith(pureTool());
    await expectToolError(
      invokeTool(unscoped, baseRequest({ resource: "issue:42" })),
      "resource_not_allowed",
    );
  });

  it("rejects parameters outside the declared bounds", async () => {
    const registry = registryWith(pureTool({ parameter_bounds: { mode: ["fast", "slow"] } }));
    const within = await invokeTool(
      registry,
      baseRequest({ parameters: { url: "https://example.test", mode: "fast" } }),
    );
    expect(within.output).toEqual({ status: "ok" });
    await expectToolError(
      invokeTool(registry, baseRequest({ parameters: { url: "https://x", mode: "ludicrous" } })),
      "parameter_out_of_bounds",
    );
  });

  it("enforces the capability grant when one is bound", async () => {
    const merged = mergePolicyLayers([]);
    const grant: CapabilityGrant = issueGrant(
      {
        grant_id: "grant_01",
        task_id: "task_01",
        capabilities: [],
        read_paths: [],
        write_paths: [],
        tools: [{ name: "http_fetch" }],
        phase: "implementation",
        budget: { steps: 10, tokens: 1000 },
      },
      merged.effective,
    );
    const registry = registryWith(pureTool());
    const allowed = await invokeTool(registry, baseRequest(), { grant });
    expect(allowed.output).toEqual({ status: "ok" });
    const narrow = issueGrant(
      {
        grant_id: "grant_02",
        task_id: "task_02",
        capabilities: [],
        read_paths: [],
        write_paths: [],
        tools: [{ name: "other_tool" }],
        phase: "implementation",
        budget: { steps: 10, tokens: 1000 },
      },
      merged.effective,
    );
    await expectToolError(
      invokeTool(registry, baseRequest(), { grant: narrow }),
      "grant_violation",
    );
  });
});

describe("invokeTool approval binding", () => {
  const approvingTool = pureTool({ requires_approval: true, risk: "high" });

  it("requires an approval digest for approval-gated tools", async () => {
    const registry = registryWith(approvingTool);
    await expectToolError(invokeTool(registry, baseRequest()), "approval_required");
  });

  it("rejects a stale approval that does not bind the normalized request", async () => {
    const registry = registryWith(approvingTool);
    const validateApproval = (digest: string, request: string): boolean =>
      digest === APPROVAL && request === "expected";
    await expectToolError(
      invokeTool(registry, baseRequest({ approval_digest: APPROVAL }), { validateApproval }),
      "approval_invalid",
    );
  });

  it("rejects approval-gated tools when no validator is bound", async () => {
    const registry = registryWith(approvingTool);
    await expectToolError(
      invokeTool(registry, baseRequest({ approval_digest: APPROVAL })),
      "approval_invalid",
    );
  });

  it("accepts an approval that binds the exact normalized request", async () => {
    const registry = registryWith(approvingTool);
    const request = baseRequest({ approval_digest: APPROVAL });
    const digest = requestDigest("http_fetch@1.0.0", request.parameters, undefined);
    const validateApproval = (approval: string, bound: string): boolean =>
      approval === APPROVAL && bound === digest;
    const evidence = await invokeTool(registry, request, { validateApproval });
    expect(evidence.request_digest).toBe(digest);
  });
});

describe("invokeTool quota, retry and timeout", () => {
  it("exhausts the per-run quota", async () => {
    const handler = vi.fn(okHandler());
    const registry = registryWith(pureTool({ max_invocations_per_run: 1 }), handler);
    await invokeTool(registry, baseRequest());
    await expectToolError(
      invokeTool(registry, baseRequest({ intent_id: "intent_02" })),
      "quota_exceeded",
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retries a failed idempotent call within max_retries", async () => {
    let calls = 0;
    const registry = registryWith(
      pureTool({ retry_class: "idempotent_only", max_retries: 2 }),
      () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return { status: "ok" };
      },
    );
    const evidence = await invokeTool(registry, baseRequest());
    expect(evidence.attempts).toBe(3);
    expect(evidence.output).toEqual({ status: "ok" });
  });

  it("never retries when retry_class is none", async () => {
    const handler = vi.fn(() => {
      throw new Error("boom");
    });
    const registry = registryWith(pureTool(), handler);
    await expectToolError(invokeTool(registry, baseRequest()), "tool_failed");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("turns a hang into a typed timeout", async () => {
    const registry = registryWith(pureTool({ timeout_ms: 10 }), hangingHandler());
    await expectToolError(invokeTool(registry, baseRequest()), "timeout");
  });
});

describe("invokeTool after-phase validation and redaction", () => {
  it("rejects output that fails the output schema", async () => {
    const registry = registryWith(pureTool(), okHandler({ unexpected: 1 }));
    const error = await expectToolError(invokeTool(registry, baseRequest()), "invalid_output");
    expect(JSON.stringify(error.details)).toContain("must NOT have additional properties");
  });

  it("redacts declared output fields from the evidence", async () => {
    const registry = registryWith(
      pureTool({ redacted_output_fields: ["detail"] }),
      okHandler({ status: "ok", detail: "raw log line" }),
    );
    const evidence = await invokeTool(registry, baseRequest());
    expect(evidence.output).toEqual({ status: "ok", detail: "[redacted]" });
    expect(evidence.redacted).toBe(true);
    expect(evidence.output_digest).toBe(contentDigest({ status: "ok", detail: "[redacted]" }));
  });
});

describe("invokeTool external side effects", () => {
  function externalRegistry(handler = okHandler()): ToolRegistry {
    return registryWith(externalTool(), handler);
  }

  function externalRequest(overrides?: Partial<ToolInvocationRequest>): ToolInvocationRequest {
    return baseRequest({
      tool: "issue_comment",
      resource: "issue:42",
      approval_digest: APPROVAL,
      idempotency_key: "op-1",
      ...overrides,
    });
  }

  const validateApproval = (): boolean => true;

  it("requires an idempotency key for external tools", async () => {
    const registry = externalRegistry();
    await expectToolError(
      invokeTool(registry, externalRequest({ idempotency_key: undefined }), {
        journal: new ActionIntentJournal(),
        validateApproval,
      }),
      "idempotency_key_required",
    );
  });

  it("opens and completes an intent around the side effect", async () => {
    const journal = new ActionIntentJournal();
    const registry = externalRegistry();
    const evidence = await invokeTool(registry, externalRequest(), { journal, validateApproval });
    expect(evidence.intent?.status).toBe("completed");
    expect(evidence.intent?.request_digest).toBe(evidence.request_digest);
    expect(journal.all()).toHaveLength(1);
  });

  it("replays a completed idempotency key without re-executing", async () => {
    const handler = vi.fn(okHandler());
    const journal = new ActionIntentJournal();
    const registry = externalRegistry(handler);
    const first = await invokeTool(registry, externalRequest(), { journal, validateApproval });
    const second = await invokeTool(registry, externalRequest({ intent_id: "intent_02" }), {
      journal,
      validateApproval,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.replayed).toBe(true);
    expect(second.output).toEqual(first.output);
  });

  it("blocks any retry of an unresolved intent until reconciliation", async () => {
    const journal = new ActionIntentJournal();
    journal.open({
      intent_id: "intent_00",
      tool: "issue_comment@1.0.0",
      request_digest: "e".repeat(64),
      resource: "issue:42",
      idempotency_key: "op-1",
    });
    const registry = externalRegistry();
    await expectToolError(
      invokeTool(registry, externalRequest(), { journal, validateApproval }),
      "reconciliation_required",
    );
  });
});

describe("invokeTool environment secret references", () => {
  it("resolves declared references at the invocation boundary", async () => {
    let seen: unknown;
    const registry = registryWith(pureTool({ secret_parameters: ["token"] }), (input) => {
      seen = input.parameters.token;
      return { status: "ok" };
    });
    const evidence = await invokeTool(
      registry,
      baseRequest({ parameters: { url: "https://example.test", token: { $env: "API_TOKEN" } } }),
      { env: { API_TOKEN: "s3cr3t-value" } },
    );
    expect(seen).toBe("s3cr3t-value");
    expect(JSON.stringify(evidence)).not.toContain("s3cr3t-value");
  });

  it("refuses references in undeclared parameters and missing env vars", async () => {
    const registry = registryWith(pureTool());
    await expect(
      invokeTool(
        registry,
        baseRequest({ parameters: { url: "https://example.test", mode: { $env: "API_TOKEN" } } }),
        { env: { API_TOKEN: "s3cr3t-value" } },
      ),
    ).rejects.toBeInstanceOf(SecretError);
    const declared = registryWith(pureTool({ secret_parameters: ["token"] }));
    await expect(
      invokeTool(
        declared,
        baseRequest({
          parameters: { url: "https://example.test", token: { $env: "MISSING_VAR" } },
        }),
        { env: {} },
      ),
    ).rejects.toMatchObject({ name: "SecretError", kind: "unresolved_secret" });
  });

  it("redacts secret values that leak into tool output", async () => {
    const registry = registryWith(
      pureTool({ secret_parameters: ["token"] }),
      okHandler({ status: "ok", detail: "echoed s3cr3t-value back" }),
    );
    const evidence = await invokeTool(
      registry,
      baseRequest({ parameters: { url: "https://example.test", token: { $env: "API_TOKEN" } } }),
      { env: { API_TOKEN: "s3cr3t-value" } },
    );
    expect(evidence.redacted).toBe(true);
    expect(JSON.stringify(evidence.output)).not.toContain("s3cr3t-value");
  });
});
