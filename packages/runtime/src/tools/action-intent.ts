import { contentDigest } from "@universal-harness-internal/core";

import {
  EXTERNAL_ACTION_STATUSES,
  type ExternalActionIntent,
  type ExternalActionStatus,
} from "../workflow/working-state.js";
import { ToolError } from "./definition.js";

/**
 * External Action Intent journal (design 13.5 and 15.2). Before any external
 * side effect, the Workflow Engine commits an intent holding the tool, the
 * normalized request digest, the target resource, the approval and the
 * idempotency key; after the call it records Completed or Uncertain. The
 * journal is the in-memory authority during a run; `workingStateIntents`
 * projects it into checkpoint proposals so resume can restore it and
 * reconcile before any retry -- a timeout never implies the side effect did
 * not happen.
 */
export interface ActionIntentRecord {
  readonly intent_id: string;
  /** `name@version` of the tool the intent binds. */
  readonly tool: string;
  /** Digest of the normalized request (secret references, never values). */
  readonly request_digest: string;
  readonly resource: string | null;
  readonly approval_digest: string | null;
  readonly idempotency_key: string;
  readonly status: ExternalActionStatus;
  readonly result_digest: string | null;
}

export interface OpenIntentInput {
  readonly intent_id: string;
  readonly tool: string;
  readonly request_digest: string;
  readonly resource?: string;
  readonly approval_digest?: string;
  readonly idempotency_key: string;
}

/** Digest of the normalized invocation request; stable across process runs. */
export function requestDigest(
  tool: string,
  parameters: Record<string, unknown>,
  resource: string | undefined,
): string {
  return contentDigest({ tool, parameters, resource: resource ?? null });
}

function transition(
  intent: ActionIntentRecord,
  status: ExternalActionStatus,
  resultDigest: string | null,
): ActionIntentRecord {
  const legal =
    (intent.status === "pending" && (status === "completed" || status === "uncertain")) ||
    (intent.status === "uncertain" && status === "completed");
  if (!legal) {
    throw new ToolError(
      "invalid_intent_transition",
      `action intent ${intent.intent_id} cannot move from ${intent.status} to ${status}`,
    );
  }
  return { ...intent, status, result_digest: resultDigest };
}

export class ActionIntentJournal {
  private readonly intents = new Map<string, ActionIntentRecord>();
  /** In-memory replay cache; never persisted, so restored journals miss. */
  private readonly outputs = new Map<string, unknown>();

  /** Restore a journal from checkpointed intents (resume path). */
  static restore(records: readonly ActionIntentRecord[]): ActionIntentJournal {
    const journal = new ActionIntentJournal();
    for (const record of records) {
      journal.intents.set(record.intent_id, record);
    }
    return journal;
  }

  /** Commit a pending intent before the side effect happens. */
  open(input: OpenIntentInput): ActionIntentRecord {
    if (this.intents.has(input.intent_id)) {
      throw new ToolError(
        "invalid_intent_transition",
        `action intent ${input.intent_id} already exists`,
      );
    }
    const record: ActionIntentRecord = {
      intent_id: input.intent_id,
      tool: input.tool,
      request_digest: input.request_digest,
      resource: input.resource ?? null,
      approval_digest: input.approval_digest ?? null,
      idempotency_key: input.idempotency_key,
      status: "pending",
      result_digest: null,
    };
    this.intents.set(record.intent_id, record);
    return record;
  }

  complete(intent: ActionIntentRecord, resultDigest: string): ActionIntentRecord {
    return this.replace(transition(intent, "completed", resultDigest));
  }

  /** Cache the redacted output for same-process idempotent replay. */
  rememberOutput(intentId: string, output: unknown): void {
    this.outputs.set(intentId, output);
  }

  outputOf(intentId: string): unknown {
    return this.outputs.get(intentId);
  }

  markUncertain(intent: ActionIntentRecord): ActionIntentRecord {
    return this.replace(transition(intent, "uncertain", null));
  }

  /**
   * Close an uncertain intent after reconciliation proved the effect applied.
   * The result digest stays null: the effect is known, its result is not, so
   * downstream consumers must treat the output as unavailable.
   */
  markReconciledApplied(intent: ActionIntentRecord): ActionIntentRecord {
    return this.replace(transition(intent, "completed", null));
  }

  /**
   * Release an intent whose effect reconciliation proved NOT applied, so the
   * idempotency key may be retried with a fresh intent. A completed intent can
   * never be released; that would reopen a finished side effect.
   */
  releaseForRetry(intent: ActionIntentRecord): void {
    if (intent.status === "completed") {
      throw new ToolError(
        "invalid_intent_transition",
        `action intent ${intent.intent_id} is completed; its idempotency key must be replayed, not retried`,
      );
    }
    this.intents.delete(intent.intent_id);
    this.outputs.delete(intent.intent_id);
  }

  private replace(record: ActionIntentRecord): ActionIntentRecord {
    this.intents.set(record.intent_id, record);
    return record;
  }

  get(intentId: string): ActionIntentRecord | undefined {
    return this.intents.get(intentId);
  }

  /** Idempotency lookup: the key scopes one logical external effect. */
  findByIdempotencyKey(tool: string, idempotencyKey: string): ActionIntentRecord | undefined {
    return this.all().find(
      (intent) => intent.tool === tool && intent.idempotency_key === idempotencyKey,
    );
  }

  /** Intents still awaiting reconciliation after an interruption. */
  unresolved(): ActionIntentRecord[] {
    return this.all().filter((intent) => intent.status !== "completed");
  }

  /** All intents in deterministic id order. */
  all(): ActionIntentRecord[] {
    return [...this.intents.values()].sort((left, right) =>
      left.intent_id < right.intent_id ? -1 : left.intent_id > right.intent_id ? 1 : 0,
    );
  }

  /** Projection into the WorkingState checkpoint proposal (design 10.2). */
  workingStateIntents(): ExternalActionIntent[] {
    return this.all().map((intent) => ({
      intent_id: intent.intent_id,
      tool: intent.tool,
      request_digest: intent.request_digest,
      idempotency_key: intent.idempotency_key,
      status: intent.status,
    }));
  }
}

/** Structural validation for intents read back from a checkpoint. */
export function isActionIntentRecord(value: unknown): value is ActionIntentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as ActionIntentRecord;
  return (
    typeof record.intent_id === "string" &&
    typeof record.tool === "string" &&
    typeof record.request_digest === "string" &&
    (typeof record.resource === "string" || record.resource === null) &&
    (typeof record.approval_digest === "string" || record.approval_digest === null) &&
    typeof record.idempotency_key === "string" &&
    (EXTERNAL_ACTION_STATUSES as readonly string[]).includes(record.status) &&
    (typeof record.result_digest === "string" || record.result_digest === null)
  );
}
