import { contentDigest } from "@universal-harness-internal/core";

/**
 * The deterministic prompt cache key (prompt governance addendum design 10).
 * The key covers every input that may change the compiled prompt plus the
 * model/config/budget identity supplied by the caller; Proposal/Review,
 * different purposes, profiles or overlays therefore never share a cache
 * entry. A cache hit never skips binding/baseline/schema verification — that
 * check lives in the runner (PG-2).
 */
export interface PromptCacheKeyParts {
  readonly port_id: string;
  readonly purpose?: string;
  readonly prompt_contract_digest: string;
  readonly profile_overlay_digest: string;
  readonly policy_overlay_digest: string;
  readonly input_bundle_digest: string;
  readonly output_schema_digest: string;
  readonly model_config_digest?: string;
  readonly budget_digest?: string;
}

export function promptCacheKey(parts: PromptCacheKeyParts): string {
  return contentDigest({
    kind: "prompt_cache_key",
    port_id: parts.port_id,
    purpose: parts.purpose ?? null,
    prompt_contract_digest: parts.prompt_contract_digest,
    profile_overlay_digest: parts.profile_overlay_digest,
    policy_overlay_digest: parts.policy_overlay_digest,
    input_bundle_digest: parts.input_bundle_digest,
    output_schema_digest: parts.output_schema_digest,
    model_config_digest: parts.model_config_digest ?? null,
    budget_digest: parts.budget_digest ?? null,
  });
}
