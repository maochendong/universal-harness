import { Type, type Static } from "@sinclair/typebox";

import {
  DigestSchema,
  ExtensionsSchema,
  IdentifierSchema,
  TimestampSchema,
  enumerated,
  persistedRecordProperties,
  strictObject,
} from "./common.js";

export const FEEDBACK_TYPES = [
  "Finding",
  "RootCauseAnalysis",
  "ImprovementCandidate",
  "ImpactSet",
] as const;

export const FEEDBACK_STATUSES = ["proposed", "accepted", "closed", "superseded"] as const;

export const FeedbackSchema = strictObject({
  ...persistedRecordProperties("feedback"),
  id: IdentifierSchema,
  type: enumerated(FEEDBACK_TYPES),
  iteration_id: IdentifierSchema,
  status: enumerated(FEEDBACK_STATUSES),
  summary: Type.String({ minLength: 1, maxLength: 10_000 }),
  created_at: TimestampSchema,
  digest: DigestSchema,
  extensions: Type.Optional(ExtensionsSchema),
});

export type FeedbackRecord = Static<typeof FeedbackSchema>;

/**
 * Extension key under which canonical Finding records carry their bound
 * subject (design 9.1). Eval's feedback module builds and validates the full
 * subject; schedulers and read models read it leniently through
 * `readFindingExtension`.
 */
export const FINDING_EXTENSION_KEY = "harness.finding";

/**
 * The leniently-read fields of a `harness.finding` extension. Every field is
 * independently optional: a missing or wrongly-typed member is dropped,
 * never trusted.
 */
export interface FindingExtension {
  readonly rule?: string;
  readonly blocking?: boolean;
  readonly blocks?: readonly string[];
}

/**
 * Read the `harness.finding` extension without assuming its shape: undefined
 * when no object sits under the key, otherwise the individually validated
 * fields.
 */
export function readFindingExtension(finding: FeedbackRecord): FindingExtension | undefined {
  const extension = finding.extensions?.[FINDING_EXTENSION_KEY];
  if (typeof extension !== "object" || extension === null) return undefined;
  const parsed = extension as { rule?: unknown; blocking?: unknown; blocks?: unknown };
  return {
    ...(typeof parsed.rule === "string" ? { rule: parsed.rule } : {}),
    ...(parsed.blocking === true ? { blocking: true } : {}),
    ...(Array.isArray(parsed.blocks) ? { blocks: parsed.blocks as readonly string[] } : {}),
  };
}
