import type { TSchema } from "@sinclair/typebox";

import { assertKnownProtocol } from "../protocol.js";
import {
  compileSchemaValidator,
  type CompiledSchemaValidator,
  type ValidationResult,
} from "./registry.js";

/**
 * Extensible per-protocol schema registry. Protocol 1.1 domain tasks register
 * their record schemas as independent entries instead of editing a fixed
 * central list; the registry pins the protocol version, validates fail-closed
 * (unregistered keys and foreign protocol versions are rejected, never
 * skipped) and emits deterministic JSON Schema documents for the export
 * tooling.
 */
export const DOMAIN_SCHEMA_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class SchemaRegistryError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid schema registry: ${reason}`);
    this.name = "SchemaRegistryError";
    this.reason = reason;
  }
}

export interface DomainSchemaEntry {
  readonly key: string;
  readonly schema: TSchema;
}

export interface DomainSchemaRegistry {
  readonly protocolVersion: string;
  readonly keys: readonly string[];
  has(key: string): boolean;
  validate(key: string, value: unknown): ValidationResult;
  documents(): Record<string, Record<string, unknown>>;
}

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_ID_BASE = "https://schemas.universal-harness.dev";

function protocolVersionOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("protocol_version" in value)) {
    return undefined;
  }
  const protocolVersion = value.protocol_version;
  return typeof protocolVersion === "string" ? protocolVersion : undefined;
}

export function createDomainSchemaRegistry(options: {
  readonly protocolVersion: string;
  readonly entries: readonly DomainSchemaEntry[];
}): DomainSchemaRegistry {
  // Unknown protocol versions fail closed at registration time.
  const registration = assertKnownProtocol(options.protocolVersion);
  const minor = options.protocolVersion.split(".")[1];
  const idNamespace = `${registration.major}.${minor}`;

  const schemas = new Map<string, TSchema>();
  for (const entry of options.entries) {
    if (!DOMAIN_SCHEMA_KEY_PATTERN.test(entry.key)) {
      throw new SchemaRegistryError(`schema key must be kebab-case: ${entry.key}`);
    }
    if (schemas.has(entry.key)) {
      throw new SchemaRegistryError(`duplicate schema key: ${entry.key}`);
    }
    if (typeof entry.schema !== "object" || entry.schema === null || Array.isArray(entry.schema)) {
      throw new SchemaRegistryError(`schema for ${entry.key} must be a JSON Schema object`);
    }
    schemas.set(entry.key, entry.schema);
  }

  // Validators compile lazily so registry construction stays cheap and free
  // of Ajv initialization ordering concerns.
  const validators = new Map<string, CompiledSchemaValidator>();
  function validatorFor(key: string): CompiledSchemaValidator | undefined {
    const schema = schemas.get(key);
    if (schema === undefined) return undefined;
    let validator = validators.get(key);
    if (validator === undefined) {
      validator = compileSchemaValidator(schema);
      validators.set(key, validator);
    }
    return validator;
  }

  return {
    protocolVersion: options.protocolVersion,
    keys: [...schemas.keys()],
    has: (key: string) => schemas.has(key),
    validate(key: string, value: unknown): ValidationResult {
      const validator = validatorFor(key);
      if (validator === undefined) {
        return {
          valid: false,
          errors: [{ instancePath: "", keyword: "schema", message: `unknown schema: ${key}` }],
        };
      }
      const result = validator(value);
      if (!result.valid) return result;
      const protocolVersion = protocolVersionOf(value);
      if (protocolVersion !== undefined && protocolVersion !== options.protocolVersion) {
        return {
          valid: false,
          errors: [
            {
              instancePath: "/protocol_version",
              keyword: "protocolCompatibility",
              message: `protocol version ${protocolVersion} does not match registry protocol ${options.protocolVersion}`,
            },
          ],
        };
      }
      return result;
    },
    documents(): Record<string, Record<string, unknown>> {
      return Object.fromEntries(
        [...schemas.entries()].map(([key, schema]) => [
          `${key}.schema.json`,
          JSON.parse(
            JSON.stringify({
              $schema: JSON_SCHEMA_DIALECT,
              $id: `${SCHEMA_ID_BASE}/${idNamespace}/${key}.schema.json`,
              ...schema,
            }),
          ),
        ]),
      ) as Record<string, Record<string, unknown>>;
    },
  };
}

/**
 * Merge export document maps from several registries into the single map the
 * schema writer persists. Name collisions between registries fail closed
 * instead of silently overwriting, which is what keeps export drift visible.
 */
export function mergeSchemaDocuments(
  ...sources: ReadonlyArray<Record<string, Record<string, unknown>>>
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const source of sources) {
    for (const [name, document] of Object.entries(source)) {
      if (name in merged) {
        throw new SchemaRegistryError(`duplicate schema document: ${name}`);
      }
      merged[name] = document;
    }
  }
  return merged;
}
