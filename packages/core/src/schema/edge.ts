import { Type, type Static } from "@sinclair/typebox";

import {
  DigestSchema,
  ExtensionsSchema,
  IdentifierSchema,
  ProvenanceSchema,
  SourceSchema,
  enumerated,
  persistedRecordProperties,
  strictObject,
} from "./common.js";

export const RELATION_TYPES = [
  "DERIVES_FROM",
  "SUPERSEDES",
  "GENERATED_BY",
  "RESUMES",
  "DECOMPOSES_TO",
  "ADDRESSES",
  "CONSTRAINED_BY",
  "GOVERNED_BY",
  "SHAPES",
  "REALIZES",
  "IMPLEMENTS",
  "VERIFIES",
  "EVALUATES",
  "EXECUTES",
  "INVOKES",
  "PRODUCES",
  "SUPPORTS",
  "REFUTES",
  "VIOLATES",
  "CONTAINS",
  "DEPENDS_ON",
  "USES_CONTEXT",
  "CAPTURES",
  "BLOCKS",
  "REQUESTS_APPROVAL_FOR",
  "RESOLVES",
  "APPROVES",
  "DIAGNOSED_BY",
  "PROPOSES_CHANGE_TO",
  "TRIGGERS",
  "MAY_IMPACT",
] as const;

export const EDGE_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;

export const EdgeSchema = strictObject({
  ...persistedRecordProperties("edge"),
  id: IdentifierSchema,
  type: enumerated(RELATION_TYPES),
  source_id: IdentifierSchema,
  target_id: IdentifierSchema,
  status: enumerated(EDGE_STATUSES),
  source: SourceSchema,
  provenance: ProvenanceSchema,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  digest: DigestSchema,
  extensions: Type.Optional(ExtensionsSchema),
});

export type EdgeRecord = Static<typeof EdgeSchema>;
