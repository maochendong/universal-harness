import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  compileSchemaValidator,
  contentDigest,
  registeredOutputSchemaDigest,
  type ModelPortFailure,
} from "@universal-harness-internal/core";

/**
 * Strict output validation (prompt governance addendum design 8, plan PG-2).
 * Raw provider text must be a single JSON document — no prose, no fences —
 * that validates against the registered output schema whose document digest
 * still equals the digest pinned at plan time. Structural validity is all
 * this layer proves; citations, boundaries and domain semantics are validated
 * separately downstream.
 */
export interface ValidateModelOutputInput {
  readonly raw: string;
  readonly output_schema_id: string;
  readonly output_schema_digest: string;
}

export type ValidateModelOutputResult =
  | { readonly ok: true; readonly value: unknown; readonly output_digest: string }
  | { readonly ok: false; readonly failure: ModelPortFailure };

function failure(code: ModelPortFailure["code"], summary: string): ValidateModelOutputResult {
  return { ok: false, failure: { code, summary, retryable: false } };
}

const validators = new Map<string, ReturnType<typeof compileSchemaValidator>>();

export function validateModelOutput(input: ValidateModelOutputInput): ValidateModelOutputResult {
  let expectedDigest: string;
  try {
    expectedDigest = registeredOutputSchemaDigest(input.output_schema_id);
  } catch {
    return failure(
      "version_mismatch",
      `unknown output schema ${input.output_schema_id}; fail closed instead of guessing`,
    );
  }
  if (expectedDigest !== input.output_schema_digest) {
    return failure(
      "version_mismatch",
      `output schema ${input.output_schema_id} drifted from the pinned digest`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(input.raw);
  } catch {
    return failure("invalid_output", "provider output is not a single JSON document");
  }
  let validator = validators.get(input.output_schema_id);
  if (validator === undefined) {
    const document =
      PROTOCOL_1_1_SCHEMA_REGISTRY.documents()[`${input.output_schema_id}.schema.json`];
    validator = compileSchemaValidator(document);
    validators.set(input.output_schema_id, validator);
  }
  const validation = validator(value);
  if (!validation.valid) {
    return failure(
      "invalid_output",
      `provider output failed schema ${input.output_schema_id}: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  return { ok: true, value, output_digest: contentDigest(value) };
}
