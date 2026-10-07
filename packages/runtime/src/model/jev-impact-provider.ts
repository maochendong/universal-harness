import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  canonicalizeJson,
  contentDigest,
  createPromptContractRegistry,
  type JevChoice,
  type JevImpactJudgments,
  type ModelPortFailure,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  JEV_IMPACT_PROMPT_REGISTRATION,
  JEV_IMPACT_PROMPT_VERSION,
} from "@universal-harness-internal/graph";

import type { ManagedModelProviderPort, ManagedModelProviderResponse } from "./managed-runner.js";
import { compilePrompt, type CompiledPrompt } from "./prompt-compiler.js";
import { wrapUntrustedBundle, type PromptInputBundle } from "./source-boundary.js";

export interface JevProjectedNode {
  readonly id: string;
  readonly type: NodeRecord["type"];
  readonly revision: number;
  readonly digest: string;
  readonly fields: Readonly<Record<string, string | readonly string[]>>;
}

export interface JevImpactRequest {
  readonly model: "jev-1.13.0";
  readonly state: {
    readonly change: JevProjectedNode;
    readonly candidates: readonly JevProjectedNode[];
  };
  readonly questions: Readonly<
    Record<
      string,
      {
        readonly type: "choice";
        readonly instructions: string;
        readonly criteria: Readonly<Record<JevChoice, string>>;
      }
    >
  >;
}

export interface JevRequestBinding {
  readonly impact_set_digest: string;
  readonly rule_registry_version: string;
  readonly rule_registry_digest: string;
  readonly candidate_set_digest: string;
  readonly projection_version: "jev-impact-projection.v1";
  readonly mapping_version: "jev-impact-mapping.v1";
  readonly limits_version: "jev-impact-limits.v1";
}

export interface BoundJevImpactRequest {
  readonly request: JevImpactRequest;
  readonly binding: JevRequestBinding;
  readonly compiled: CompiledPrompt;
}

export interface JevImpactProviderFactory {
  bind(input: BoundJevImpactRequest): ManagedModelProviderPort;
}

export function buildJevInputBundle(
  request: JevImpactRequest,
  binding: JevRequestBinding,
): PromptInputBundle {
  return {
    bundle_id: `jev-input_${contentDigest({ request, binding })}`,
    items: [
      { source_id: "jev-request", source_kind: "jev-request", text: canonicalizeJson(request) },
      { source_id: "jev-binding", source_kind: "jev-binding", text: canonicalizeJson(binding) },
    ],
  };
}

function failure(
  code: ModelPortFailure["code"],
  summary: string,
  retryable = false,
): ManagedModelProviderResponse {
  return { ok: false, failure: { code, summary, retryable } };
}

function validBinding(bound: BoundJevImpactRequest): boolean {
  try {
    if (
      bound.request.model !== "jev-1.13.0" ||
      bound.binding.candidate_set_digest !== contentDigest(bound.request.state.candidates) ||
      bound.binding.mapping_version !== "jev-impact-mapping.v1" ||
      bound.binding.projection_version !== "jev-impact-projection.v1" ||
      bound.binding.limits_version !== "jev-impact-limits.v1"
    )
      return false;
    const candidateIds = bound.request.state.candidates.map((candidate) => candidate.id).sort();
    if (
      new Set(candidateIds).size !== candidateIds.length ||
      canonicalizeJson(candidateIds) !==
        canonicalizeJson(Object.keys(bound.request.questions).sort())
    )
      return false;
    const bundle = buildJevInputBundle(bound.request, bound.binding);
    if (
      wrapUntrustedBundle(bundle, "source-delimiter.v1").bundle_digest !==
      bound.compiled.input_bundle_digest
    )
      return false;
    // Impact currently has no project Policy clauses. Recompile the three allowed
    // profiles rather than trusting caller-supplied message or contract digests.
    const registry = createPromptContractRegistry([JEV_IMPACT_PROMPT_REGISTRATION]);
    return (["lite", "standard", "governed"] as const).some((profile) => {
      const result = compilePrompt({
        registry,
        selector: { port_id: "impact_advisory", prompt_version: JEV_IMPACT_PROMPT_VERSION },
        profile,
        input_bundle: bundle,
      });
      return result.ok && canonicalizeJson(result.compiled) === canonicalizeJson(bound.compiled);
    });
  } catch {
    return false;
  }
}

function validatedResponse(
  raw: unknown,
  bound: BoundJevImpactRequest,
): ManagedModelProviderResponse {
  if (typeof raw === "object" && raw !== null && "model" in raw && raw.model !== "jev-1.13.0") {
    return failure("version_mismatch", "Jev response model differs from the pinned version");
  }
  const output = {
    schema_version: "jev-impact-judgments.v1",
    provider_response: raw,
    harness: {
      request_digest: contentDigest(bound.request),
      candidate_set_digest: bound.binding.candidate_set_digest,
      mapping_version: bound.binding.mapping_version,
    },
  };
  if (!PROTOCOL_1_1_SCHEMA_REGISTRY.validate("jev-impact-judgments", output).valid) {
    return failure("invalid_output", "Jev response violates the strict output schema");
  }
  const result = output as JevImpactJudgments;
  const providerResponse = result.provider_response;
  if (
    canonicalizeJson(Object.keys(providerResponse.answers).sort()) !==
    canonicalizeJson(Object.keys(bound.request.questions).sort())
  ) {
    return failure("invalid_output", "Jev answer set differs from the requested candidates");
  }
  for (const answer of Object.values(providerResponse.answers)) {
    const probabilities = Object.values(answer.probabilities);
    if (
      !probabilities.every((probability) => Number.isFinite(probability)) ||
      Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 0.002 + Number.EPSILON ||
      answer.probabilities[answer.choice] < Math.max(...probabilities) ||
      !Number.isFinite(answer.confidence)
    ) {
      return failure("invalid_output", "Jev answer probability distribution is invalid");
    }
  }
  const tokens = providerResponse.usage.input_tokens + providerResponse.usage.output_tokens;
  if (!Number.isSafeInteger(tokens))
    return failure("invalid_output", "Jev token usage is not a safe integer");
  return { ok: true, content: canonicalizeJson(result), usage: { tokens } };
}

class JevResponseLimitError extends Error {}

async function readBoundedResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (signal.aborted) {
      cancel();
      throw new Error("cancelled");
    }
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("cancelled");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        cancel();
        throw new JevResponseLimitError();
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createJevImpactProviderFactory(options: {
  readonly fetch?: typeof fetch;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
}): JevImpactProviderFactory {
  const fetchImpl = options.fetch ?? fetch;
  const environment = options.ambientEnvironment ?? process.env;
  return {
    bind(input) {
      const bound = structuredClone(input);
      const bindingValid = validBinding(bound);
      let attempted = false;
      return {
        async invoke(invocation) {
          if (
            !bindingValid ||
            invocation.output_schema_id !== "jev-impact-judgments" ||
            canonicalizeJson(invocation.messages) !== canonicalizeJson(bound.compiled.messages)
          ) {
            return failure("policy_denied", "Jev request does not match its compiled binding");
          }
          if (invocation.signal?.aborted)
            return failure("timeout", "Jev invocation cancelled", true);
          if (attempted)
            return failure(
              "policy_denied",
              "Jev bound request already attempted; use audited recovery",
            );
          const apiKey = environment["TYPESAFE_API_KEY"];
          if (apiKey === undefined || apiKey.trim() === "")
            return failure("provider_required", "Jev requires TYPESAFE_API_KEY");
          const controller = new AbortController();
          const cancel = () => controller.abort();
          invocation.signal?.addEventListener("abort", cancel, { once: true });
          const timer = setTimeout(cancel, invocation.timeout_ms);
          try {
            attempted = true;
            const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
              body: canonicalizeJson(bound.request),
            });
            if (!response.ok) {
              void response.body?.cancel().catch(() => undefined);
              if (
                response.status === 401 ||
                response.status === 403 ||
                (response.status >= 300 && response.status < 400)
              ) {
                return failure("policy_denied", "Jev authorization or redirect rejected");
              }
              if (response.status === 429 || response.status >= 500) {
                return failure("provider_unavailable", "Jev service unavailable", true);
              }
              return failure("invalid_output", "Jev request rejected");
            }
            const text = await readBoundedResponse(
              response,
              invocation.max_output_bytes,
              controller.signal,
            );
            try {
              return validatedResponse(JSON.parse(text) as unknown, bound);
            } catch {
              return failure("invalid_output", "Jev response is not valid JSON");
            }
          } catch (error) {
            if (error instanceof JevResponseLimitError)
              return failure("budget_exhausted", "Jev response exceeds the output byte budget");
            if (
              error instanceof TypeError &&
              error.cause instanceof Error &&
              error.cause.message === "unexpected redirect"
            ) {
              return failure("policy_denied", "Jev redirect rejected");
            }
            return controller.signal.aborted
              ? failure("timeout", "Jev invocation cancelled or timed out", true)
              : failure("provider_unavailable", "Jev network request failed", true);
          } finally {
            clearTimeout(timer);
            invocation.signal?.removeEventListener("abort", cancel);
          }
        },
      };
    },
  };
}
