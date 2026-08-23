import {
  contentDigest,
  sealRecordEnvelope,
  type ModelInvocationRecord,
  type ModelInvocationState,
  type ModelPortFailure,
} from "@universal-harness-internal/core";

/**
 * Model invocation lifecycle records (prompt governance addendum design 5.4,
 * plan PG-2). `planned` pins every digest that shapes the call — contract,
 * overlays, input bundle, output schema, provider/config/budget and the cache
 * key — and each transition appends a new sealed revision. Prior revisions
 * are never mutated; drift invalidates unconsumed results instead.
 */

/** The binding facts a managed invocation needs, from any binding carrier. */
export interface ManagedInvocationBinding {
  readonly provider_identity: string;
  readonly config_digest: string;
  readonly prompt_contract_id: string;
  readonly prompt_contract_version: string;
  readonly prompt_contract_digest: string;
  readonly output_schema_digest: string;
  readonly budget_profile: string;
}

export interface PlanModelInvocationInput {
  readonly invocation_id: string;
  readonly conversation_id: string;
  readonly run_id: string;
  readonly attempt: number;
  readonly port_id: string;
  readonly purpose?: string;
  readonly binding: ManagedInvocationBinding;
  readonly output_schema_id: string;
  readonly profile_overlay_digest: string;
  readonly policy_overlay_digest: string;
  readonly input_bundle_digest: string;
  readonly compiled_prompt_digest: string;
  readonly cache_key: string;
}

export class InvocationTransitionError extends Error {
  constructor(from: ModelInvocationState, to: ModelInvocationState) {
    super(`Illegal model invocation transition: ${from} -> ${to}`);
    this.name = "InvocationTransitionError";
  }
}

const LEGAL_TRANSITIONS: Readonly<Record<ModelInvocationState, readonly ModelInvocationState[]>> = {
  planned: ["started", "failed", "invalidated"],
  started: ["completed", "failed", "invalidated"],
  completed: ["validated", "failed", "invalidated"],
  failed: [],
  validated: ["consumed", "invalidated"],
  consumed: [],
  invalidated: [],
};

export function planModelInvocation(input: PlanModelInvocationInput): ModelInvocationRecord {
  const record = {
    protocol_version: "1.1.0" as const,
    record_kind: "model_invocation" as const,
    invocation_id: input.invocation_id,
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    attempt: input.attempt,
    revision: 1,
    port_id: input.port_id,
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    prompt_contract_id: input.binding.prompt_contract_id,
    prompt_contract_version: input.binding.prompt_contract_version,
    prompt_contract_digest: input.binding.prompt_contract_digest,
    output_schema_id: input.output_schema_id,
    output_schema_digest: input.binding.output_schema_digest,
    profile_overlay_digest: input.profile_overlay_digest,
    policy_overlay_digest: input.policy_overlay_digest,
    input_bundle_digest: input.input_bundle_digest,
    compiled_prompt_digest: input.compiled_prompt_digest,
    provider_identity: input.binding.provider_identity,
    config_digest: input.binding.config_digest,
    budget_profile: input.binding.budget_profile,
    cache_key: input.cache_key,
    state: "planned" as const,
  };
  return sealRecordEnvelope(record);
}

export interface InvocationTransitionPatch {
  readonly failure?: ModelPortFailure;
  readonly output_digest?: string;
  readonly artifact_locator?: string;
  readonly result_locator?: string;
  readonly usage?: ModelInvocationRecord["usage"];
}

/** Append the next sealed revision; illegal transitions throw, never coerce. */
export function transitionModelInvocation(
  record: ModelInvocationRecord,
  to: ModelInvocationState,
  patch: InvocationTransitionPatch = {},
): ModelInvocationRecord {
  if (!LEGAL_TRANSITIONS[record.state].includes(to)) {
    throw new InvocationTransitionError(record.state, to);
  }
  const next: Record<string, unknown> = {
    ...record,
    revision: record.revision + 1,
    state: to,
  };
  delete next["record_digest"];
  if (to === "failed") {
    if (patch.failure === undefined) {
      throw new InvocationTransitionError(record.state, to);
    }
    next["failure"] = patch.failure;
  }
  if (patch.output_digest !== undefined) next["output_digest"] = patch.output_digest;
  if (patch.artifact_locator !== undefined) next["artifact_locator"] = patch.artifact_locator;
  if (patch.result_locator !== undefined) next["result_locator"] = patch.result_locator;
  if (patch.usage !== undefined) next["usage"] = patch.usage;
  return sealRecordEnvelope(next as Omit<ModelInvocationRecord, "record_digest">);
}

/** The identity digests two revisions of one invocation must always share. */
export function invocationIdentityDigest(record: ModelInvocationRecord): string {
  return contentDigest({
    invocation_id: record.invocation_id,
    conversation_id: record.conversation_id,
    run_id: record.run_id,
    attempt: record.attempt,
    port_id: record.port_id,
    purpose: record.purpose ?? null,
    prompt_contract_digest: record.prompt_contract_digest,
    compiled_prompt_digest: record.compiled_prompt_digest,
  });
}
