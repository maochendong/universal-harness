import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";
import type { TSchema } from "@sinclair/typebox";

import { isProtocolCompatible } from "../version.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import { createDomainSchemaRegistry, mergeSchemaDocuments } from "./domain-registry.js";
import { EdgeSchema } from "./edge.js";
import { EventSchema } from "./event.js";
import { FeedbackSchema } from "./feedback.js";
import { NodeSchema } from "./node.js";
import { ObservationEventSchema } from "./observation.js";
import { LedgerOperationSchema, OperationSchema, WorkflowOperationSchema } from "./operation.js";
import { PluginManifestSchema } from "./plugin.js";
import { RuntimeSchema } from "./runtime.js";

export const SCHEMA_KEYS = [
  "node",
  "edge",
  "event",
  "observation",
  "operation",
  "workflow-operation",
  "ledger-operation",
  "runtime",
  "feedback",
  "plugin",
] as const;

export type SchemaKey = (typeof SCHEMA_KEYS)[number];

export const SCHEMA_REGISTRY = {
  node: NodeSchema,
  edge: EdgeSchema,
  event: EventSchema,
  observation: ObservationEventSchema,
  operation: OperationSchema,
  "workflow-operation": WorkflowOperationSchema,
  "ledger-operation": LedgerOperationSchema,
  runtime: RuntimeSchema,
  feedback: FeedbackSchema,
  plugin: PluginManifestSchema,
} as const satisfies Record<SchemaKey, TSchema>;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
const addFormats = addFormatsImport as unknown as FormatsPlugin;
addFormats(ajv);

const validators = new Map<SchemaKey, ValidateFunction>(
  SCHEMA_KEYS.map((key) => [key, ajv.compile(SCHEMA_REGISTRY[key])]),
);

export type ValidationIssue = {
  instancePath: string;
  keyword: string;
  message: string;
};

export type ValidationResult =
  { valid: true; errors: [] } | { valid: false; errors: ValidationIssue[] };

function normalizeErrors(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
  }));
}

function protocolVersionOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("protocol_version" in value)) {
    return undefined;
  }
  const protocolVersion = value.protocol_version;
  return typeof protocolVersion === "string" ? protocolVersion : undefined;
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
  const validate = ajv.compile(document);
  return (value: unknown): ValidationResult =>
    validate(value)
      ? { valid: true, errors: [] }
      : { valid: false, errors: normalizeErrors(validate.errors) };
}

export function validateSchema(key: SchemaKey, value: unknown): ValidationResult {
  const validator = validators.get(key);
  if (validator === undefined) {
    return {
      valid: false,
      errors: [{ instancePath: "", keyword: "schema", message: `unknown schema: ${key}` }],
    };
  }

  if (!validator(value)) {
    return { valid: false, errors: normalizeErrors(validator.errors) };
  }

  if (key === "observation") {
    return { valid: true, errors: [] };
  }

  const protocolVersion = protocolVersionOf(value);
  if (protocolVersion === undefined || !isProtocolCompatible(protocolVersion)) {
    return {
      valid: false,
      errors: [
        {
          instancePath: "/protocol_version",
          keyword: "protocolCompatibility",
          message: `unsupported protocol version: ${protocolVersion ?? "missing"}`,
        },
      ],
    };
  }

  return { valid: true, errors: [] };
}

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

function schemaDocument(name: string, schema: TSchema): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      $schema: JSON_SCHEMA_DIALECT,
      $id: `https://schemas.universal-harness.dev/m1/${name}`,
      ...schema,
    }),
  ) as Record<string, unknown>;
}

export const JSON_SCHEMA_DOCUMENTS = Object.fromEntries(
  SCHEMA_KEYS.map((key) => [
    `${key}.schema.json`,
    schemaDocument(`${key}.schema.json`, SCHEMA_REGISTRY[key]),
  ]),
) as Record<string, Record<string, unknown>>;

/**
 * Protocol 1.1 domain schemas register here as their owning tasks land
 * (Profile T2, Capability T3, Capture T4-T7, and so on). Task 1 ships only
 * the extensible plumbing, so the registry starts empty.
 */
export const PROTOCOL_1_1_SCHEMA_REGISTRY = createDomainSchemaRegistry({
  protocolVersion: PROTOCOL_1_1_VERSION,
  entries: [],
});

/** Every document scripts/write-schemas.mjs persists into `schemas/`. */
export const SCHEMA_EXPORT_DOCUMENTS = mergeSchemaDocuments(
  JSON_SCHEMA_DOCUMENTS,
  PROTOCOL_1_1_SCHEMA_REGISTRY.documents(),
);
