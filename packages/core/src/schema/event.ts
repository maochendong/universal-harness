import { Type, type Static } from "@sinclair/typebox";

import {
  ExtensionsSchema,
  IdentifierSchema,
  TimestampSchema,
  enumerated,
  persistedRecordProperties,
  strictObject,
} from "./common.js";

export const EVENT_TYPES = [
  "OperationStarted",
  "PlanAccepted",
  "BeforeContextCompile",
  "ContextCompiled",
  "BeforeToolCall",
  "AfterToolCall",
  "ApprovalRequired",
  "CheckpointCommitted",
  "CheckpointInvalidated",
  "GateCompleted",
  "EvaluationCompleted",
  "FindingCreated",
  "FindingAccepted",
  "FindingClosed",
  "FindingSuperseded",
  "OperationCompleted",
  "TddCycleStarted",
  "TddBaselineAccepted",
  "TddTestPatchFrozen",
  "TddRedAccepted",
  "TddImplementationUnlocked",
  "TddGreenAccepted",
  "TddRefactorAccepted",
  "TddCycleCompleted",
  "TddCycleInvalidated",
  // Protocol 1.2 (M3): the only authoritative remote-collaboration events.
  // Lease and candidate Integration state never enter the project Ledger.
  "RemoteConnected",
  "RemoteDisconnected",
  "RemoteApprovalMaterialized",
  "IntegrationAccepted",
] as const;

export const EventSchema = strictObject({
  ...persistedRecordProperties("event"),
  event_id: IdentifierSchema,
  event_type: enumerated(EVENT_TYPES),
  project_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  ledger_operation_id: IdentifierSchema,
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: TimestampSchema,
  payload: Type.Record(Type.String(), Type.Unknown()),
  extensions: Type.Optional(ExtensionsSchema),
});

export type LifecycleEvent = Static<typeof EventSchema>;
