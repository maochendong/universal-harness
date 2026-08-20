import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compilePrompt } from "../../packages/runtime/src/model/prompt-compiler.js";
import {
  planModelInvocation,
  transitionModelInvocation,
} from "../../packages/runtime/src/model/invocation-records.js";
import {
  appendModelInvocationRecord,
  readModelInvocationRecords,
  recoverableModelInvocations,
} from "../../packages/runtime/src/model/invocation-store.js";
import {
  managedInvocationCacheKey,
  runManagedInvocation,
  type ManagedModelProviderPort,
  type RunManagedInvocationParams,
} from "../../packages/runtime/src/model/managed-runner.js";
import {
  createPromptContractRegistry,
  definePromptContract,
} from "../../packages/core/src/index.js";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});

/**
 * PG-2 fault cases: a crash between any two persisted invocation states must
 * reconcile from the store alone — no duplicate result consumption, no
 * rewritten history, no stuck invocation.
 */
const registry = createPromptContractRegistry([
  {
    contract: definePromptContract({
      contract_id: "harness:prompt:fault-port",
      port_id: "fault_port",
      version: "1.0.0",
      authority_boundary: { segment_id: "authority-boundary", text: "Harness owns authority." },
      role_instruction: { segment_id: "role", text: "Fault test role." },
      domain_rubric: { segment_id: "domain-rubric", text: "Stay grounded." },
      profile_overlays: {
        lite: { segment_id: "profile-lite", text: "Minimal depth." },
        standard: { segment_id: "profile-standard", text: "Standard depth." },
        governed: { segment_id: "profile-governed", text: "Governed depth." },
      },
      output_schema_id: "approval-brief-output",
      source_delimiter_version: "source-delimiter.v1",
    }),
    prompt_versions: ["fault-port.v1"],
  },
]);

const VALID_OUTPUT = JSON.stringify({
  purpose: "approval_brief",
  schema_version: "approval-brief.v1",
  bundle_digest: "a".repeat(64),
  changes: [],
  risks: [],
  tradeoffs: [],
  open_questions: [],
});

function compiledPrompt() {
  const result = compilePrompt({
    registry,
    selector: { port_id: "fault_port", prompt_version: "fault-port.v1" },
    profile: "standard",
    input_bundle: {
      bundle_id: "bundle_fault",
      items: [{ source_id: "readme", source_kind: "readme", text: "demo" }],
    },
  });
  if (!result.ok) throw new Error("expected ok");
  return result.compiled;
}

function params(root: string, provider?: ManagedModelProviderPort): RunManagedInvocationParams {
  const contract = registry.contracts[0]!;
  const compiled = compiledPrompt();
  return {
    projectRoot: root,
    identity: {
      invocation_id: "invocation_01K1FAULT",
      conversation_id: "conversation_01K1FAULT",
      run_id: "run_01K1FAULT",
    },
    port_id: "fault_port",
    binding: {
      provider_identity: "provider_anthropic",
      config_digest: "0".repeat(64),
      prompt_contract_id: contract.contract_id,
      prompt_contract_version: contract.version,
      prompt_contract_digest: contract.contract_digest,
      output_schema_digest: contract.output_schema_digest,
      budget_profile: "capture-standard",
    },
    output_schema_id: "approval-brief-output",
    compiled,
    budget: { timeout_ms: 5_000, max_output_bytes: 64 * 1024 },
    ...(provider === undefined ? {} : { provider }),
  };
}

function providerReturning(content: string): ManagedModelProviderPort {
  return { invoke: vi.fn(async () => ({ ok: true as const, content })) };
}

function seedCrash(root: string, stopAt: "planned" | "started" | "completed" | "validated"): void {
  const p = params(root);
  const planned = planModelInvocation({
    invocation_id: p.identity.invocation_id,
    conversation_id: p.identity.conversation_id,
    run_id: p.identity.run_id,
    attempt: 1,
    port_id: p.port_id,
    binding: p.binding,
    output_schema_id: p.output_schema_id,
    profile_overlay_digest: p.compiled.profile_overlay_digest,
    policy_overlay_digest: p.compiled.policy_overlay_digest,
    input_bundle_digest: p.compiled.input_bundle_digest,
    compiled_prompt_digest: p.compiled.compiled_prompt_digest,
    cache_key: managedInvocationCacheKey(p),
  });
  appendModelInvocationRecord(root, planned);
  if (stopAt === "planned") return;
  const started = transitionModelInvocation(planned, "started");
  appendModelInvocationRecord(root, started);
  if (stopAt === "started") return;
  const completed = transitionModelInvocation(started, "completed", {
    output_digest: "2".repeat(64),
  });
  appendModelInvocationRecord(root, completed);
  if (stopAt === "completed") return;
  appendModelInvocationRecord(root, transitionModelInvocation(completed, "validated"));
}

describe("model invocation crash reconciliation", () => {
  it("resumes a crash after planned and completes exactly once", async () => {
    const root = makeTempDir("harness-fault-planned-");
    seedCrash(root, "planned");
    const provider = providerReturning(VALID_OUTPUT);
    const outcome = await runManagedInvocation(params(root, provider));
    expect(outcome.status).toBe("validated");
    const records = readModelInvocationRecords(root);
    expect(records.filter((record) => record.state === "planned")).toHaveLength(1);
    expect(recoverableModelInvocations(records)).toHaveLength(1); // validated, not yet consumed
  });

  it("resumes a crash after started as a fresh attempt with history intact", async () => {
    const root = makeTempDir("harness-fault-started-");
    seedCrash(root, "started");
    const provider = providerReturning(VALID_OUTPUT);
    const outcome = await runManagedInvocation(params(root, provider));
    expect(outcome.status).toBe("validated");
    const records = readModelInvocationRecords(root);
    expect(Math.max(...records.map((record) => record.attempt))).toBe(2);
    expect(records.filter((record) => record.attempt === 1).map((record) => record.state)).toEqual([
      "planned",
      "started",
    ]);
  });

  it("resumes a crash after completed without consuming the stale output", async () => {
    const root = makeTempDir("harness-fault-completed-");
    seedCrash(root, "completed");
    const provider = providerReturning(VALID_OUTPUT);
    const outcome = await runManagedInvocation(params(root, provider));
    expect(outcome.status).toBe("validated");
    // The stale completed output (unknown validity) is never consumed.
    expect(
      readModelInvocationRecords(root).filter((record) => record.state === "consumed"),
    ).toHaveLength(0);
  });

  it("replays after a post-consumption crash with zero provider calls", async () => {
    const root = makeTempDir("harness-fault-consumed-");
    const provider = providerReturning(VALID_OUTPUT);
    const first = await runManagedInvocation(params(root, provider));
    expect(first.status).toBe("validated");
    appendModelInvocationRecord(
      root,
      transitionModelInvocation(readModelInvocationRecords(root).at(-1)!, "consumed"),
    );
    const second = await runManagedInvocation(params(root, provider));
    expect(second.status).toBe("replayed");
    expect(provider.invoke as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(recoverableModelInvocations(readModelInvocationRecords(root))).toHaveLength(0);
  });
});
