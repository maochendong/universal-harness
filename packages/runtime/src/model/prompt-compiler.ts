import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  PromptContractError,
  contentDigest,
  type ProfileId,
  type PromptContract,
  type PromptContractRegistry,
  type PromptContractSelector,
  type PromptPreparationFailure,
  type PromptPreparationFailureCode,
} from "@universal-harness-internal/core";

import {
  PromptPolicyOverlayError,
  compilePolicyOverlay,
  type PromptPolicyOverlayClause,
} from "./prompt-policy.js";
import {
  SourceBoundaryError,
  wrapUntrustedBundle,
  type PromptInputBundle,
} from "./source-boundary.js";

export type { PromptInputBundle, PromptInputItem } from "./source-boundary.js";

/**
 * The deterministic, provider-side-effect-free PromptCompiler (prompt
 * governance addendum design 6, plan PG-1). The seven-partition message order
 * is a protocol invariant; callers can never inject a custom system prompt,
 * and all project content lands in the untrusted partition only. Compilation
 * is pure: no project directory, Ledger, environment or provider access.
 */
export const PROMPT_MESSAGE_PARTITIONS = [
  "authority_boundary",
  "role_instruction",
  "domain_rubric",
  "profile_overlay",
  "policy_overlay",
  "output_contract",
  "untrusted_input",
] as const;
export type PromptPartition = (typeof PROMPT_MESSAGE_PARTITIONS)[number];

const PARTITION_TAGS: Readonly<Record<PromptPartition, string>> = {
  authority_boundary: "authority-boundary",
  role_instruction: "port-role",
  domain_rubric: "domain-rubric",
  profile_overlay: "profile-overlay",
  policy_overlay: "policy-overlay",
  output_contract: "output-contract",
  untrusted_input: "untrusted-input",
};

export interface CompiledPromptMessage {
  readonly role: "system" | "user";
  readonly partition: PromptPartition;
  readonly content: string;
  readonly digest: string;
}

/** The compiled prompt (addendum design 5.3): digests plus the messages. */
export interface CompiledPrompt {
  readonly contract_id: string;
  readonly contract_digest: string;
  readonly profile_overlay_digest: string;
  readonly policy_overlay_digest: string;
  readonly input_bundle_digest: string;
  readonly output_schema_digest: string;
  readonly compiled_prompt_digest: string;
  readonly messages: readonly CompiledPromptMessage[];
}

export interface CompilePromptParams {
  readonly registry: PromptContractRegistry;
  readonly selector: PromptContractSelector;
  readonly profile: ProfileId;
  readonly policy_overlay?: readonly PromptPolicyOverlayClause[];
  readonly input_bundle: PromptInputBundle;
}

export type CompilePromptResult =
  | { readonly ok: true; readonly compiled: CompiledPrompt }
  | { readonly ok: false; readonly failure: PromptPreparationFailure };

function preparationFailure(
  code: PromptPreparationFailureCode,
  summary: string,
  contractId?: string,
): CompilePromptResult {
  return {
    ok: false,
    failure: {
      code,
      summary,
      retryable: false,
      ...(contractId === undefined ? {} : { contract_id: contractId }),
    },
  };
}

function systemMessage(partition: PromptPartition, body: string): CompiledPromptMessage {
  const tag = PARTITION_TAGS[partition];
  const content = `<${tag}>\n${body}\n</${tag}>`;
  return {
    role: "system",
    partition,
    content,
    digest: contentDigest({ partition, content }),
  };
}

/** Resolve the contract and re-verify the resolution against its content. */
function resolveContract(params: CompilePromptParams): PromptContract {
  const resolution = params.registry.resolve(params.selector);
  const contract = params.registry.contracts.find(
    (candidate) =>
      candidate.contract_id === resolution.prompt_contract_id &&
      candidate.version === resolution.prompt_contract_version,
  );
  if (contract === undefined || contract.contract_digest !== resolution.prompt_contract_digest) {
    throw new PromptContractError(
      "prompt_contract_digest_mismatch",
      `registry resolution for ${resolution.prompt_contract_id} does not match any registered contract content`,
    );
  }
  return contract;
}

/**
 * The output contract names the pinned schema AND reproduces the schema
 * document verbatim: a model that only sees a schema id/digest has no way to
 * know the required fields (real-provider dogfood, T20 slice 3: outputs
 * free-styled field names and failed closed as invalid_output). A schema id
 * missing from the protocol registry fails closed at preparation time.
 */
function outputContractBody(contract: PromptContract): string {
  const document =
    PROTOCOL_1_1_SCHEMA_REGISTRY.documents()[`${contract.output_schema_id}.schema.json`];
  if (document === undefined) {
    throw new PromptContractError(
      "output_schema_mismatch",
      `output schema ${contract.output_schema_id} is not in the protocol 1.1 schema registry`,
    );
  }
  return [
    `Respond with a single JSON document that validates against the registered output schema "${contract.output_schema_id}" (digest ${contract.output_schema_digest}), reproduced here in full:`,
    JSON.stringify(document),
    "Do not add, rename or omit fields; do not emit prose, markdown fences or commentary outside the JSON document.",
  ].join("\n");
}

export function compilePrompt(params: CompilePromptParams): CompilePromptResult {
  try {
    const contract = resolveContract(params);
    const overlay = contract.profile_overlays[params.profile];
    if (overlay === undefined) {
      return preparationFailure(
        "profile_overlay_missing",
        `contract ${contract.contract_id} has no overlay for profile ${params.profile}`,
        contract.contract_id,
      );
    }
    const policy = compilePolicyOverlay(params.policy_overlay ?? []);
    const untrusted = wrapUntrustedBundle(params.input_bundle, contract.source_delimiter_version);

    const profileOverlayDigest = contentDigest({
      kind: "profile_overlay",
      profile: params.profile,
      segment_id: overlay.segment_id,
      text: overlay.text,
    });
    const messages: CompiledPromptMessage[] = [
      systemMessage("authority_boundary", contract.authority_boundary.text),
      systemMessage("role_instruction", contract.role_instruction.text),
      systemMessage("domain_rubric", contract.domain_rubric.text),
      systemMessage("profile_overlay", overlay.text),
      systemMessage("policy_overlay", policy.content),
      systemMessage("output_contract", outputContractBody(contract)),
      {
        role: "user",
        partition: "untrusted_input",
        content: untrusted.content,
        digest: contentDigest({ partition: "untrusted_input", content: untrusted.content }),
      },
    ];
    const compiledPromptDigest = contentDigest({
      kind: "compiled_prompt",
      contract_digest: contract.contract_digest,
      profile: params.profile,
      profile_overlay_digest: profileOverlayDigest,
      policy_overlay_digest: policy.overlay_digest,
      input_bundle_digest: untrusted.bundle_digest,
      output_schema_digest: contract.output_schema_digest,
      source_delimiter_version: contract.source_delimiter_version,
      message_digests: messages.map((message) => message.digest),
    });
    return {
      ok: true,
      compiled: {
        contract_id: contract.contract_id,
        contract_digest: contract.contract_digest,
        profile_overlay_digest: profileOverlayDigest,
        policy_overlay_digest: policy.overlay_digest,
        input_bundle_digest: untrusted.bundle_digest,
        output_schema_digest: contract.output_schema_digest,
        compiled_prompt_digest: compiledPromptDigest,
        messages,
      },
    };
  } catch (error) {
    if (error instanceof PromptContractError) {
      return preparationFailure(error.code, error.message);
    }
    if (error instanceof PromptPolicyOverlayError) {
      return preparationFailure(error.code, error.message);
    }
    if (error instanceof SourceBoundaryError) {
      return preparationFailure(error.code, error.message);
    }
    throw error;
  }
}

/** The result of a slot-guarded compilation. */
export type SlotCompileResult =
  | { readonly status: "slot_disabled" }
  | { readonly status: "compiled"; readonly compiled: CompiledPrompt }
  | { readonly status: "failed"; readonly failure: PromptPreparationFailure };

/**
 * Lite slot guard (plan PG-1 test 8): a disabled model slot must never reach
 * the compiler — zero compilation, zero artifacts, zero invocations.
 */
export function compilePromptForSlot(
  slot: { readonly enabled: boolean },
  compile: () => CompilePromptResult,
): SlotCompileResult {
  if (!slot.enabled) {
    return { status: "slot_disabled" };
  }
  const result = compile();
  return result.ok
    ? { status: "compiled", compiled: result.compiled }
    : { status: "failed", failure: result.failure };
}
