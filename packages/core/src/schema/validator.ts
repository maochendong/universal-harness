import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";

/**
 * Shared Ajv instance and validation primitives. This module sits below both
 * the fixed 1.0 registry (`registry.ts`) and the extensible 1.1 domain
 * registry (`domain-registry.ts`) so the two never import each other.
 */
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
const addFormats = addFormatsImport as unknown as FormatsPlugin;
addFormats(ajv);

export type ValidationIssue = {
  instancePath: string;
  keyword: string;
  message: string;
};

export type ValidationResult =
  { valid: true; errors: [] } | { valid: false; errors: ValidationIssue[] };

export function normalizeErrors(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
  }));
}

/** Compile a schema against the shared Ajv instance. */
export function compileAjvSchema(schema: unknown): ValidateFunction {
  return ajv.compile(schema as object);
}

/**
 * Compiled validator for an arbitrary JSON Schema 2020-12 document, used by
 * versioned Tool Descriptors whose input/output schemas are provider data
 * rather than fixed protocol schemas (design 13.5). The `$id` keyword is
 * stripped before compilation so two tools may share a schema document
 * without colliding in the Ajv registry; every other keyword keeps its
 * strict-mode semantics.
 */
export type CompiledSchemaValidator = (value: unknown) => ValidationResult;

export function compileSchemaValidator(schema: unknown): CompiledSchemaValidator {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("a compilable schema must be a JSON Schema object");
  }
  const document = { ...(schema as Record<string, unknown>) };
  delete document.$id;
  const validate = compileAjvSchema(document);
  return (value: unknown): ValidationResult =>
    validate(value)
      ? { valid: true, errors: [] }
      : { valid: false, errors: normalizeErrors(validate.errors) };
}
