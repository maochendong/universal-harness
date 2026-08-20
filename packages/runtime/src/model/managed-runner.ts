import {
  contentDigest,
  type ModelInvocationRecord,
  type ModelPortFailure,
} from "@universal-harness-internal/core";

import {
  planModelInvocation,
  transitionModelInvocation,
  type ManagedInvocationBinding,
} from "./invocation-records.js";
import {
  appendModelInvocationRecord,
  latestModelInvocation,
  readModelInvocationRecords,
} from "./invocation-store.js";
import { writeSanitizedPromptArtifact, type PromptArtifactSink } from "./prompt-artifact.js";
import { promptCacheKey } from "./prompt-cache-key.js";
import type { CompiledPrompt, CompiledPromptMessage } from "./prompt-compiler.js";
import { validateModelOutput } from "./result-validation.js";

/**
 * The managed model invocation runner (prompt governance addendum design 8,
 * plan PG-2). The only provider call path: it accepts a CompiledPrompt plus a
 * persisted binding and invocation identity — never raw prompt text. Every
 * state transition is persisted before the next step, so a crash at any point
 * reconciles from the store without consuming a result twice.
 */

/** The complete provider boundary: compiled messages plus limits, nothing else. */
export interface ManagedModelProviderRequest {
  readonly messages: readonly CompiledPromptMessage[];
  readonly output_schema_id: string;
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
}

export type ManagedModelProviderResponse =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly failure: ModelPortFailure };

export interface ManagedModelProviderPort {
  invoke(request: ManagedModelProviderRequest): Promise<ManagedModelProviderResponse>;
}

export interface ManagedInvocationIdentity {
  readonly invocation_id: string;
  readonly conversation_id: string;
  readonly run_id: string;
}

export interface ManagedInvocationBudget {
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
}

export interface RunManagedInvocationParams {
  readonly projectRoot: string;
  readonly identity: ManagedInvocationIdentity;
  readonly port_id: string;
  readonly purpose?: string;
  readonly binding: ManagedInvocationBinding;
  readonly output_schema_id: string;
  readonly compiled: CompiledPrompt;
  readonly budget: ManagedInvocationBudget;
  readonly provider?: ManagedModelProviderPort;
  readonly artifact_sink?: PromptArtifactSink;
  /**
   * Skip terminal replays and cache hits and mint a fresh attempt. Callers use
   * this exactly once when a replayed outcome cannot supply the value they
   * need (raw outputs are never persisted — only digests and locators).
   */
  readonly force_fresh?: boolean;
}

export type ManagedInvocationOutcome =
  | {
      readonly status: "validated";
      readonly record: ModelInvocationRecord;
      readonly value: unknown;
      readonly output_digest: string;
    }
  | { readonly status: "replayed"; readonly record: ModelInvocationRecord }
  | {
      readonly status: "failed";
      readonly record: ModelInvocationRecord;
      readonly failure: ModelPortFailure;
    };

export class ManagedRunnerError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ManagedRunnerError";
    this.kind = kind;
  }
}

interface CurrentDigests {
  readonly prompt_contract_digest: string;
  readonly output_schema_digest: string;
  readonly compiled_prompt_digest: string;
  readonly cache_key: string;
}

type DigestParams = Pick<
  RunManagedInvocationParams,
  "port_id" | "purpose" | "binding" | "compiled"
>;

function currentDigests(params: DigestParams): CurrentDigests {
  return {
    prompt_contract_digest: params.binding.prompt_contract_digest,
    output_schema_digest: params.binding.output_schema_digest,
    compiled_prompt_digest: params.compiled.compiled_prompt_digest,
    cache_key: promptCacheKey({
      port_id: params.port_id,
      ...(params.purpose === undefined ? {} : { purpose: params.purpose }),
      prompt_contract_digest: params.binding.prompt_contract_digest,
      profile_overlay_digest: params.compiled.profile_overlay_digest,
      policy_overlay_digest: params.compiled.policy_overlay_digest,
      input_bundle_digest: params.compiled.input_bundle_digest,
      output_schema_digest: params.binding.output_schema_digest,
      model_config_digest: params.binding.config_digest,
      budget_digest: contentDigest({ budget_profile: params.binding.budget_profile }),
    }),
  };
}

function digestsOf(record: ModelInvocationRecord): CurrentDigests {
  return {
    prompt_contract_digest: record.prompt_contract_digest,
    output_schema_digest: record.output_schema_digest,
    compiled_prompt_digest: record.compiled_prompt_digest,
    cache_key: record.cache_key,
  };
}

function sameDigests(left: CurrentDigests, right: CurrentDigests): boolean {
  return (
    left.prompt_contract_digest === right.prompt_contract_digest &&
    left.output_schema_digest === right.output_schema_digest &&
    left.compiled_prompt_digest === right.compiled_prompt_digest &&
    left.cache_key === right.cache_key
  );
}

function failure(code: ModelPortFailure["code"], summary: string, retryable: boolean) {
  return { code, summary, retryable } satisfies ModelPortFailure;
}

/** The cache key the runner derives for these params (recovery/test seam). */
export function managedInvocationCacheKey(params: DigestParams): string {
  return currentDigests(params).cache_key;
}

function plan(params: RunManagedInvocationParams, attempt: number): ModelInvocationRecord {
  const digests = currentDigests(params);
  const record = planModelInvocation({
    invocation_id: params.identity.invocation_id,
    conversation_id: params.identity.conversation_id,
    run_id: params.identity.run_id,
    attempt,
    port_id: params.port_id,
    ...(params.purpose === undefined ? {} : { purpose: params.purpose }),
    binding: params.binding,
    output_schema_id: params.output_schema_id,
    profile_overlay_digest: params.compiled.profile_overlay_digest,
    policy_overlay_digest: params.compiled.policy_overlay_digest,
    input_bundle_digest: params.compiled.input_bundle_digest,
    compiled_prompt_digest: params.compiled.compiled_prompt_digest,
    cache_key: digests.cache_key,
  });
  appendModelInvocationRecord(params.projectRoot, record);
  return record;
}

function transition(
  params: RunManagedInvocationParams,
  record: ModelInvocationRecord,
  to: Parameters<typeof transitionModelInvocation>[1],
  patch: Parameters<typeof transitionModelInvocation>[2] = {},
): ModelInvocationRecord {
  const next = transitionModelInvocation(record, to, patch);
  appendModelInvocationRecord(params.projectRoot, next);
  return next;
}

function failed(
  params: RunManagedInvocationParams,
  record: ModelInvocationRecord,
  modelFailure: ModelPortFailure,
): ManagedInvocationOutcome {
  const failedRecord = transition(params, record, "failed", { failure: modelFailure });
  return { status: "failed", record: failedRecord, failure: modelFailure };
}

const TERMINAL = new Set(["consumed", "failed", "invalidated"]);

export async function runManagedInvocation(
  params: RunManagedInvocationParams,
): Promise<ManagedInvocationOutcome> {
  // Binding/compiled consistency: any drift between the persisted binding and
  // the compiled prompt fails closed before anything is planned.
  if (
    params.binding.prompt_contract_digest !== params.compiled.contract_digest ||
    params.binding.output_schema_digest !== params.compiled.output_schema_digest
  ) {
    throw new ManagedRunnerError(
      "binding_drift",
      "binding digest does not match the compiled prompt; re-resolve the binding first",
    );
  }

  const records = readModelInvocationRecords(params.projectRoot);
  const digests = currentDigests(params);
  const sameId = records.filter((record) => record.invocation_id === params.identity.invocation_id);
  const latest =
    sameId.length === 0 ? undefined : latestModelInvocation(sameId, params.identity.invocation_id);

  let attempt = 1;
  if (latest !== undefined) {
    if (
      latest.conversation_id !== params.identity.conversation_id ||
      latest.run_id !== params.identity.run_id ||
      latest.port_id !== params.port_id ||
      (latest.purpose ?? undefined) !== params.purpose
    ) {
      throw new ManagedRunnerError(
        "identity_conflict",
        `invocation ${params.identity.invocation_id} already exists under a different identity`,
      );
    }
    if (TERMINAL.has(latest.state)) {
      if (!sameDigests(digestsOf(latest), digests)) {
        throw new ManagedRunnerError(
          "identity_conflict",
          `invocation ${params.identity.invocation_id} is terminal under different digests`,
        );
      }
      if (params.force_fresh === true) {
        attempt = latest.attempt + 1;
      } else if (latest.state === "consumed" || latest.state === "invalidated") {
        return { status: "replayed", record: latest };
      } else {
        return { status: "failed", record: latest, failure: latest.failure! };
      }
    } else if (params.force_fresh === true) {
      attempt = latest.attempt + 1;
    } else if (!sameDigests(digestsOf(latest), digests)) {
      // Drift: invalidate only the unconsumed result, keep history verbatim.
      transition(params, latest, "invalidated");
      attempt = latest.attempt + 1;
    } else if (latest.state === "planned") {
      attempt = latest.attempt;
    } else {
      // Crash at started/completed/validated: resume as a fresh attempt.
      attempt = latest.attempt + 1;
    }
  }

  // Independence: a conversation may never span contracts or cache keys.
  const sharedConversation = records.find(
    (record) =>
      record.conversation_id === params.identity.conversation_id &&
      record.invocation_id !== params.identity.invocation_id,
  );
  if (sharedConversation !== undefined && sharedConversation.cache_key !== digests.cache_key) {
    const planned = plan(params, attempt);
    return failed(
      params,
      planned,
      failure(
        "independence_violation",
        `conversation ${params.identity.conversation_id} was already used by ${sharedConversation.invocation_id} under a different cache key`,
        false,
      ),
    );
  }

  // Cache: an identical cache key with a validated/consumed result replays.
  const cacheHit = records.find(
    (record) =>
      record.cache_key === digests.cache_key &&
      record.invocation_id !== params.identity.invocation_id &&
      (record.state === "validated" || record.state === "consumed"),
  );
  if (cacheHit !== undefined && params.force_fresh !== true) {
    return { status: "replayed", record: cacheHit };
  }

  const planned = plan(params, attempt);

  if (params.provider === undefined) {
    return failed(
      params,
      planned,
      failure("provider_required", "a required model provider is not configured", false),
    );
  }

  const artifactLocator =
    params.artifact_sink === undefined
      ? undefined
      : writeSanitizedPromptArtifact(params.compiled, params.artifact_sink).locator;
  const started = transition(
    params,
    planned,
    "started",
    artifactLocator === undefined ? {} : { artifact_locator: artifactLocator },
  );

  let response: ManagedModelProviderResponse;
  try {
    response = await Promise.race([
      params.provider.invoke({
        messages: params.compiled.messages,
        output_schema_id: params.output_schema_id,
        timeout_ms: params.budget.timeout_ms,
        max_output_bytes: params.budget.max_output_bytes,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("provider call timed out")), params.budget.timeout_ms);
      }),
    ]);
  } catch {
    return failed(
      params,
      started,
      failure("timeout", `provider call exceeded ${params.budget.timeout_ms}ms`, true),
    );
  }
  if (!response.ok) {
    return failed(params, started, response.failure);
  }
  if (Buffer.byteLength(response.content, "utf8") > params.budget.max_output_bytes) {
    return failed(
      params,
      started,
      failure(
        "budget_exhausted",
        `provider output exceeded ${params.budget.max_output_bytes} bytes`,
        false,
      ),
    );
  }

  const validation = validateModelOutput({
    raw: response.content,
    output_schema_id: params.output_schema_id,
    output_schema_digest: params.binding.output_schema_digest,
  });
  if (!validation.ok) {
    return failed(params, started, validation.failure);
  }
  const completed = transition(params, started, "completed", {
    output_digest: validation.output_digest,
  });
  const validated = transition(params, completed, "validated");
  return {
    status: "validated",
    record: validated,
    value: validation.value,
    output_digest: validation.output_digest,
  };
}
