import {
  PROTOCOL_VERSION,
  validateSchema,
  type LifecycleEvent,
} from "@universal-harness-internal/core";

export type FindingLifecycleAction = "accept" | "close" | "supersede";

export interface FindingLifecyclePayloadInput {
  readonly findingId: string;
  readonly from: string;
  readonly to: string;
  readonly actor: string;
  readonly cause: string;
  readonly evidenceId?: string;
  readonly groupId?: string;
  readonly oldSubjectDigests?: readonly string[];
  readonly newSubjectDigests?: readonly string[];
}

export function findingLifecycleEventType(
  action: FindingLifecycleAction,
): "FindingAccepted" | "FindingClosed" | "FindingSuperseded" {
  return action === "accept"
    ? "FindingAccepted"
    : action === "close"
      ? "FindingClosed"
      : "FindingSuperseded";
}

export function findingLifecyclePayload(
  input: FindingLifecyclePayloadInput,
): Record<string, unknown> {
  return {
    finding_id: input.findingId,
    from: input.from,
    to: input.to,
    actor: input.actor,
    cause: input.cause,
    ...(input.evidenceId === undefined ? {} : { evidence_id: input.evidenceId }),
    ...(input.groupId === undefined ? {} : { group_id: input.groupId }),
    ...(input.oldSubjectDigests === undefined
      ? {}
      : { old_subject_digests: [...input.oldSubjectDigests].sort() }),
    ...(input.newSubjectDigests === undefined
      ? {}
      : { new_subject_digests: [...input.newSubjectDigests].sort() }),
  };
}

export function buildFindingLifecycleEvent(input: {
  readonly eventId: string;
  readonly action: FindingLifecycleAction;
  readonly projectId: string;
  readonly iterationId: string;
  readonly workflowOperationId: string;
  readonly ledgerOperationId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly payload: FindingLifecyclePayloadInput;
}): LifecycleEvent {
  const record = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "event",
    event_id: input.eventId,
    event_type: findingLifecycleEventType(input.action),
    project_id: input.projectId,
    iteration_id: input.iterationId,
    workflow_operation_id: input.workflowOperationId,
    ledger_operation_id: input.ledgerOperationId,
    sequence: input.sequence,
    timestamp: input.timestamp,
    payload: findingLifecyclePayload(input.payload),
  };
  const validation = validateSchema("event", record);
  if (!validation.valid) {
    throw new Error(
      `invalid Finding lifecycle event: ${validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  return record as LifecycleEvent;
}
