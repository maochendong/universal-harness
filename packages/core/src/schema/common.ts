import { Type, type TObject, type TProperties, type TUnsafe } from "@sinclair/typebox";

import { PROTOCOL_MAJOR_VERSION, PROTOCOL_VERSION } from "../version.js";

export const ProtocolVersionSchema = Type.String({
  pattern: `^${PROTOCOL_MAJOR_VERSION}\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$`,
  default: PROTOCOL_VERSION,
});

export const IdentifierSchema = Type.String({
  minLength: 3,
  maxLength: 160,
  pattern: "^[a-z][a-z0-9-]*_[A-Za-z0-9_-]+$",
});

export const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const TimestampSchema = Type.String({ format: "date-time" });
export const LocatorSchema = Type.String({ pattern: "^repo://[^/]+(?:/.*)?$" });

export const PERSISTED_SOURCES = [
  "human",
  "scanner",
  "agent",
  "workflow",
  "tool",
  "gate",
  "evaluation",
  "audit",
  "migration",
] as const;

export const SourceSchema = enumerated(PERSISTED_SOURCES);

export const ProvenanceSchema = strictObject({
  iteration_id: IdentifierSchema,
  run_id: Type.Optional(IdentifierSchema),
  actor: Type.String({ minLength: 1, maxLength: 200 }),
  timestamp: TimestampSchema,
});

export const ExtensionsSchema = Type.Record(
  Type.String({ pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$" }),
  Type.Unknown(),
  { additionalProperties: false, default: {} },
);

export function strictObject<T extends TProperties>(properties: T): TObject<T> {
  return Type.Object(properties, { additionalProperties: false });
}

export function enumerated<const T extends readonly string[]>(values: T): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ anyOf: values.map((value) => Type.Literal(value)) });
}

export function persistedRecordProperties(recordKind: string): TProperties {
  return {
    protocol_version: ProtocolVersionSchema,
    record_kind: Type.Literal(recordKind),
  };
}
