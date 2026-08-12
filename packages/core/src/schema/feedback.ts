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
