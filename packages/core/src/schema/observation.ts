import { Type, type Static } from "@sinclair/typebox";

import { IdentifierSchema, TimestampSchema, enumerated, strictObject } from "./common.js";

export const OBSERVATION_EVENT_TYPES = [
  "PhaseStarted",
  "PhaseCompleted",
  "PhasePaused",
  "GateStarted",
  "GateCompleted",
  "RunStarted",
  "RunHeartbeat",
  "RunOutputSummary",
  "BudgetUpdated",
  "ApprovalRequired",
] as const;

export const ObservationEventSchema = strictObject({
  stream_version: Type.Literal(1),
  stream_id: IdentifierSchema,
  sequence: Type.Integer({ minimum: 1 }),
  observation_key: IdentifierSchema,
  event_type: enumerated(OBSERVATION_EVENT_TYPES),
  project_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  timestamp: TimestampSchema,
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export type ObservationEvent = Static<typeof ObservationEventSchema>;
