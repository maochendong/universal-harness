import { contentDigest } from "../identity/digest.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import type { PromptContract, PromptPreparationFailureCode } from "../schema/prompt.js";

/**
 * PromptContract construction helpers (prompt governance addendum design
 * 5.1). A contract is domain-owned protocol registry data: its
 * `output_schema_digest` is derived from the exported JSON Schema document
 * and its `contract_digest` from the canonical content — callers never supply
 * either digest by hand.
 */
export class PromptContractError extends Error {
  readonly code: PromptPreparationFailureCode;

  constructor(code: PromptPreparationFailureCode, message: string) {
    super(message);
    this.name = "PromptContractError";
    this.code = code;
  }
}

/** The exported JSON Schema document digest for one registered output schema. */
export function registeredOutputSchemaDigest(outputSchemaKey: string): string {
  const document = PROTOCOL_1_1_SCHEMA_REGISTRY.documents()[`${outputSchemaKey}.schema.json`];
  if (document === undefined) {
    throw new PromptContractError(
      "output_schema_mismatch",
      `unknown prompt output schema: ${outputSchemaKey}`,
    );
  }
  return contentDigest(document);
}

/**
 * Canonical digest of a contract's full content (every field except
 * `contract_digest` itself). Key order never changes the digest; any semantic
 * change must.
 */
export function promptContractDigest(contract: Omit<PromptContract, "contract_digest">): string {
  return contentDigest(contract);
}

/**
 * Define one immutable contract: the output schema digest is sealed from the
 * registered schema document, then the contract digest seals the content.
 */
export function definePromptContract(
  input: Omit<PromptContract, "contract_digest" | "output_schema_digest">,
): PromptContract {
  const content: Omit<PromptContract, "contract_digest"> = {
    ...input,
    output_schema_digest: registeredOutputSchemaDigest(input.output_schema_id),
  };
  return { ...content, contract_digest: promptContractDigest(content) };
}
