import {
  LedgerRepository,
  PROTOCOL_VERSION,
  canonicalizeJson,
  contentDigest,
  validateSchema,
  type LifecycleEvent,
} from "@universal-harness-internal/core";

import type { DagCheckpointEntry, DagCheckpointStore } from "./dag.js";

export interface LedgerDagCheckpointStoreOptions {
  readonly projectRoot: string;
  readonly project_id: string;
  readonly iteration_id: string;
  readonly attempt_id: string;
  readonly readBaseline: () => string;
  readonly now?: () => string;
}

export class LedgerDagCheckpointStoreError extends Error {
  readonly kind = "ledger_dag_checkpoint_store" as const;

  constructor(message: string) {
    super(message);
    this.name = "LedgerDagCheckpointStoreError";
  }
}

function isCheckpointEntry(value: unknown): value is DagCheckpointEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<DagCheckpointEntry>;
  return (
    Number.isInteger(entry.sequence) &&
    (entry.sequence ?? 0) > 0 &&
    typeof entry.node_id === "string" &&
    typeof entry.plan_digest === "string" &&
    typeof entry.wiring_digest === "string" &&
    typeof entry.input_digests === "object" &&
    entry.input_digests !== null &&
    typeof entry.output_digests === "object" &&
    entry.output_digests !== null &&
    typeof entry.checkpoint_id === "string"
  );
}

export class LedgerDagCheckpointStore implements DagCheckpointStore {
  private readonly options: LedgerDagCheckpointStoreOptions;
  private readonly repository: LedgerRepository;

  constructor(options: LedgerDagCheckpointStoreOptions) {
    this.options = options;
    this.repository = new LedgerRepository({
      projectRoot: options.projectRoot,
      readBaseline: options.readBaseline,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  load(operationId: string): readonly DagCheckpointEntry[] {
    const journal: DagCheckpointEntry[] = [];
    for (const event of this.repository.replay().events) {
      if (event.workflow_operation_id !== operationId) continue;
      if (event.payload["dag_action"] === "append") {
        const entry = event.payload["entry"];
        if (!isCheckpointEntry(entry)) {
          throw new LedgerDagCheckpointStoreError(`invalid DAG checkpoint event ${event.event_id}`);
        }
        journal.push(entry);
      } else if (event.payload["dag_action"] === "invalidate_tail") {
        const keep = event.payload["keep"];
        if (!Number.isInteger(keep) || (keep as number) < 0 || (keep as number) > journal.length) {
          throw new LedgerDagCheckpointStoreError(
            `invalid DAG invalidation event ${event.event_id}`,
          );
        }
        journal.splice(keep as number);
      }
    }
    return journal;
  }

  async append(operationId: string, entry: DagCheckpointEntry): Promise<void> {
    const current = this.load(operationId);
    const expectedSequence = current.length + 1;
    if (entry.sequence !== expectedSequence) {
      const existing = current[entry.sequence - 1];
      if (existing !== undefined && canonicalizeJson(existing) === canonicalizeJson(entry)) return;
      throw new LedgerDagCheckpointStoreError(
        `DAG checkpoint sequence mismatch: expected ${String(expectedSequence)}, got ${String(entry.sequence)}`,
      );
    }
    await this.commitFact(operationId, "append", { entry });
  }

  async truncate(operationId: string, keep: number): Promise<void> {
    const current = this.load(operationId);
    if (!Number.isInteger(keep) || keep < 0 || keep > current.length) {
      throw new LedgerDagCheckpointStoreError(
        `invalid DAG checkpoint prefix length ${String(keep)}`,
      );
    }
    if (keep === current.length) return;
    await this.commitFact(operationId, "invalidate_tail", {
      keep,
      invalidated_checkpoint_ids: current.slice(keep).map((entry) => entry.checkpoint_id),
    });
  }

  private async commitFact(
    operationId: string,
    action: "append" | "invalidate_tail",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const factDigest = contentDigest({ operation_id: operationId, action, payload });
    const ledgerOperationId = `ledger_dagcp_${factDigest.slice(0, 24)}`;
    if (
      this.repository
        .operations()
        .some((operation) => operation.manifest.ledger_operation_id === ledgerOperationId)
    ) {
      return;
    }
    const replay = this.repository.replay();
    const sequence =
      replay.events
        .filter((event) => event.workflow_operation_id === operationId)
        .reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    const eventType =
      action === "append" ? ("CheckpointCommitted" as const) : ("CheckpointInvalidated" as const);
    const draft = {
      protocol_version: PROTOCOL_VERSION,
      record_kind: "event",
      event_id: `event_dagcp_${factDigest.slice(0, 24)}`,
      event_type: eventType,
      project_id: this.options.project_id,
      iteration_id: this.options.iteration_id,
      workflow_operation_id: operationId,
      ledger_operation_id: ledgerOperationId,
      sequence,
      timestamp: (this.options.now ?? (() => new Date().toISOString()))(),
      payload: { dag_action: action, ...payload },
    };
    const validation = validateSchema("event", draft);
    if (!validation.valid) {
      throw new LedgerDagCheckpointStoreError(
        `invalid DAG checkpoint lifecycle event: ${validation.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    const event = draft as LifecycleEvent;
    await this.repository.commit({
      ledger_operation_id: ledgerOperationId,
      workflow_operation_id: operationId,
      attempt_id: this.options.attempt_id,
      expected_baseline: this.options.readBaseline(),
      artifacts: [
        {
          path: `artifacts/dag-checkpoints/${factDigest}.json`,
          content: `${canonicalizeJson({ operation_id: operationId, action, ...payload })}\n`,
        },
      ],
      events: [event],
    });
  }
}
