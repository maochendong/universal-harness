import { Type, type Static } from "@sinclair/typebox";

import { PROTOCOL_1_2_VERSION } from "../protocol.js";
import {
  DigestSchema,
  ExtensionsSchema,
  IdentifierSchema,
  TimestampSchema,
  enumerated,
  persistedRecordProperties,
  strictObject,
} from "./common.js";
import type { ITERATION_STATES } from "./node.js";

export const OPERATION_STATES = [
  "created",
  "awaiting_input",
  "awaiting_approval",
  "planned",
  "running",
  "verifying",
  "repairing",
  "blocked",
  "completed",
  "aborted",
] as const;

export const RESUMABLE_OPERATION_STATES = [
  "created",
  "awaiting_input",
  "awaiting_approval",
  "planned",
  "running",
  "verifying",
  "repairing",
] as const;

export type IterationState = (typeof ITERATION_STATES)[number];
export type OperationState = (typeof OPERATION_STATES)[number];

export const OPERATION_TO_ITERATION_STATE = {
  created: "draft",
  awaiting_input: "draft",
  awaiting_approval: "draft",
  planned: "planned",
  running: "running",
  verifying: "verifying",
  repairing: "running",
  blocked: "blocked",
  completed: "completed",
  aborted: "aborted",
} as const satisfies Record<OperationState, IterationState>;

export function iterationStateForOperation(state: OperationState): IterationState {
  return OPERATION_TO_ITERATION_STATE[state];
}

export const WorkflowOperationSchema = Type.Object(
  {
    ...persistedRecordProperties("workflow_operation"),
    workflow_operation_id: IdentifierSchema,
    attempt_id: IdentifierSchema,
    iteration_id: IdentifierSchema,
    state: enumerated(OPERATION_STATES),
    resume_state: Type.Optional(enumerated(RESUMABLE_OPERATION_STATES)),
    updated_at: TimestampSchema,
    extensions: Type.Optional(ExtensionsSchema),
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: { properties: { state: { const: "blocked" } }, required: ["state"] },
        then: { properties: { resume_state: {} }, required: ["resume_state"] },
        else: {
          not: { properties: { resume_state: {} }, required: ["resume_state"] },
        },
      },
    ],
  },
);

export const LedgerOperationSchema = strictObject({
  ...persistedRecordProperties("ledger_operation"),
  ledger_operation_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  baseline_commit: Type.String({ minLength: 7, maxLength: 64, pattern: "^[a-f0-9]+$" }),
  sequence: Type.Integer({ minimum: 1 }),
  artifact_digests: Type.Array(DigestSchema, { uniqueItems: true }),
  edge_file: Type.String({ pattern: "^ledger/edges/[0-9]{4}-[0-9]{2}/[^/]+\\.jsonl$" }),
  event_file: Type.String({ pattern: "^events/[0-9]{4}-[0-9]{2}/[^/]+\\.jsonl$" }),
  // Content digests of the immutable shard files. Writers must record them so
  // materialization can reject a manifest whose shard bytes no longer match.
  edge_file_digest: Type.Optional(DigestSchema),
  event_file_digest: Type.Optional(DigestSchema),
  // Protocol 1.2: written exactly when the transaction carries a 1.2
  // authoritative Artifact/Event; older readers must fail closed with
  // `protocol_upgrade_required` instead of silently projecting the record.
  required_reader_version: Type.Optional(Type.Literal(PROTOCOL_1_2_VERSION)),
  committed_at: TimestampSchema,
  digest: DigestSchema,
  extensions: Type.Optional(ExtensionsSchema),
});

export const OperationSchema = Type.Union([WorkflowOperationSchema, LedgerOperationSchema]);

export type WorkflowOperation = Static<typeof WorkflowOperationSchema>;
export type LedgerOperation = Static<typeof LedgerOperationSchema>;
