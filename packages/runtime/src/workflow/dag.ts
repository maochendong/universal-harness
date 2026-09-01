import type {
  BindingKindV13,
  CapabilityId,
  OperationDagNode,
} from "@universal-harness-internal/core";

/**
 * DAG node contract (plan Task 8-A; slim-profiles design 9.4/9.5). The
 * Workflow Engine speaks exactly four vocabularies: the Operation DAG the
 * Capability Compiler emitted, node runners behind this contract, checkpoint
 * journal entries and typed results. Profile names, tier differences and
 * module semantics live in the registry/compiler/contributors — never here.
 */

/** One authoritative artifact a node produced, identified by its digest. */
export interface DagProducedBinding {
  readonly kind: BindingKindV13;
  readonly digest: string;
}

/** Approval a node awaits; the engine pauses without committing the node. */
export interface DagApprovalNotice {
  readonly object_id: string;
  readonly object_kind: string;
  readonly object_digest: string;
}

/**
 * The only outcomes a node runner may report. A thrown error is a crash: the
 * engine converts it into a typed `failed` run outcome without committing the
 * node, so a resume re-runs exactly that node. Runners must be idempotent —
 * a node paused on approval is re-invoked after the decision lands.
 */
export type DagNodeResult =
  | { readonly status: "committed"; readonly produces?: readonly DagProducedBinding[] }
  | {
      /** Durable node boundary requested by a host's bounded drive command. */
      readonly status: "paused";
      readonly reason: "until_phase";
      readonly produces?: readonly DagProducedBinding[];
    }
  | {
      readonly status: "plan_superseded";
      readonly next_plan_digest: string;
      readonly produces: readonly DagProducedBinding[];
    }
  | { readonly status: "awaiting_approval"; readonly approval: DagApprovalNotice }
  | { readonly status: "blocked"; readonly reason: string; readonly detail: string };

export interface DagNodeContext {
  readonly operation_id: string;
  /** Digest of the CapabilityPlan revision this run executes. */
  readonly plan_digest: string;
  readonly node: OperationDagNode;
  /**
   * Resolved inputs: every binding kind the node consumes, mapped to the
   * digest the producing node committed earlier in this DAG. Canonical order.
   */
  readonly inputs: Readonly<Record<string, string>>;
}

export type DagNodeRunner = (context: DagNodeContext) => Promise<DagNodeResult> | DagNodeResult;

/**
 * Runner lookup. Kernel nodes resolve by `node_id`, module nodes by
 * `capability_id`. Runners for nodes the DAG does not contain are never
 * resolved — an absent optional module gets zero invocations.
 */
export interface DagRunnerRegistry {
  readonly kernel: Readonly<Record<string, DagNodeRunner>>;
  readonly modules?: Readonly<Partial<Record<CapabilityId, DagNodeRunner>>>;
}

/**
 * One committed node boundary. The journal is the resume contract: an entry
 * is accepted on replay only when the node id, its wiring (dependencies and
 * declared bindings) and its resolved inputs all match, so a capability
 * upgrade that rewires the DAG invalidates from the earliest affected node.
 */
export interface DagCheckpointEntry {
  readonly sequence: number;
  readonly node_id: string;
  readonly plan_digest: string;
  readonly wiring_digest: string;
  readonly input_digests: Readonly<Record<string, string>>;
  readonly output_digests: Readonly<Record<string, string>>;
  readonly checkpoint_id: string;
}

/**
 * Checkpoint journal persistence port. Implementations must make `append`
 * durable before returning; `truncate` drops every entry at index >= `keep`
 * (used when invalidation rewinds the journal to the last valid prefix).
 */
export interface DagCheckpointStore {
  load(operationId: string): readonly DagCheckpointEntry[] | Promise<readonly DagCheckpointEntry[]>;
  append(operationId: string, entry: DagCheckpointEntry): void | Promise<void>;
  truncate(operationId: string, keep: number): void | Promise<void>;
}

/** Volatile store for tests and embedders without a ledger. */
export class InMemoryDagCheckpointStore implements DagCheckpointStore {
  private readonly journals = new Map<string, DagCheckpointEntry[]>();

  load(operationId: string): readonly DagCheckpointEntry[] {
    return [...(this.journals.get(operationId) ?? [])];
  }

  append(operationId: string, entry: DagCheckpointEntry): void {
    const journal = this.journals.get(operationId) ?? [];
    journal.push(entry);
    this.journals.set(operationId, journal);
  }

  truncate(operationId: string, keep: number): void {
    const journal = this.journals.get(operationId) ?? [];
    this.journals.set(operationId, journal.slice(0, keep));
  }
}

/** Engine-side progress; emitted only for nodes the DAG actually contains. */
export type DagEngineEvent =
  | { readonly type: "node_started"; readonly node_id: string }
  | { readonly type: "node_committed"; readonly node_id: string; readonly checkpoint_id: string }
  | { readonly type: "node_replayed"; readonly node_id: string };
