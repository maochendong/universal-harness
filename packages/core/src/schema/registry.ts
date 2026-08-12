import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";
import type { TSchema } from "@sinclair/typebox";

import { isProtocolCompatible } from "../version.js";
import { EdgeSchema } from "./edge.js";
import { EventSchema } from "./event.js";
import { FeedbackSchema } from "./feedback.js";
import { NodeSchema } from "./node.js";
import { LedgerOperationSchema, OperationSchema, WorkflowOperationSchema } from "./operation.js";
import { PluginManifestSchema } from "./plugin.js";
import { RuntimeSchema } from "./runtime.js";

export const SCHEMA_KEYS = [
  "node",
  "edge",
  "event",
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
