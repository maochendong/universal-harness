import type { ActionIntentJournal, ActionIntentRecord } from "./action-intent.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Uncertain-result reconciliation (design 13.5 and 15.2). Resume reconciles
 * every pending or uncertain Action Intent before any retry: a completed
 * effect is reused instead of replayed, a provably unapplied effect may be
 * retried, and anything the provider cannot prove -- or any tool declared
 * `manual` -- requires human review. A timeout never implies the external
 * action did not happen, so reconciliation, not blind replay, is the only
 * way forward.
 */
export const PROBE_OUTCOMES = ["applied", "not_applied", "unknown"] as const;

export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/**
 * Provider-side probe for one intent: `applied` means the effect provably
 * happened, `not_applied` means the provider proves it did not, `unknown`
 * means it cannot tell.
 */
export type ReconciliationProbe = (
  intent: ActionIntentRecord,
) => ProbeOutcome | Promise<ProbeOutcome>;

export const RECONCILIATION_DECISIONS = [
  "reuse_result",
  "retry_allowed",
  "manual_required",
] as const;

export type ReconciliationDecisionKind = (typeof RECONCILIATION_DECISIONS)[number];

export interface ReconciliationDecision {
  readonly intent_id: string;
  readonly tool: string;
  readonly idempotency_key: string;
  readonly decision: ReconciliationDecisionKind;
  readonly reason: string;
}

function decide(
  intent: ActionIntentRecord,
  decision: ReconciliationDecisionKind,
  reason: string,
): ReconciliationDecision {
  return {
    intent_id: intent.intent_id,
    tool: intent.tool,
    idempotency_key: intent.idempotency_key,
    decision,
    reason,
  };
}

/**
 * Reconcile one unresolved intent. Completed intents never reach this path:
 * they are idempotency-cache hits, not reconciliation subjects.
 */
export async function reconcileIntent(
  intent: ActionIntentRecord,
  registry: ToolRegistry,
  probe?: ReconciliationProbe,
): Promise<ReconciliationDecision> {
  const entry = registry.get(intent.tool.split("@")[0] as string, intent.tool.split("@")[1]);
  if (entry === undefined) {
    return decide(
      intent,
      "manual_required",
      `tool ${intent.tool} is no longer registered; the intent cannot be reconciled automatically`,
    );
  }
  if (entry.definition.reconciliation === "manual") {
    return decide(
      intent,
      "manual_required",
      `tool ${intent.tool} declares manual reconciliation; human review is required`,
    );
  }
  if (probe === undefined) {
    return decide(
      intent,
      "manual_required",
      `tool ${intent.tool} offers no reconciliation probe; an uncertain external result ` +
        "is never retried blindly",
    );
  }
  const outcome = await probe(intent);
  switch (outcome) {
    case "applied":
      return decide(
        intent,
        "reuse_result",
        `provider proves the effect of intent ${intent.intent_id} applied; the side effect ` +
          "is reused, not replayed",
      );
    case "not_applied":
      return decide(
        intent,
        "retry_allowed",
        `provider proves the effect of intent ${intent.intent_id} was not applied; ` +
          "retrying the idempotency key is safe",
      );
    case "unknown":
      return decide(
        intent,
        "manual_required",
        `provider cannot prove the outcome of intent ${intent.intent_id}; human review is required`,
      );
  }
}

/**
 * Reconcile every unresolved intent in the journal, in deterministic intent
 * id order.
 */
export async function reconcileJournal(
  journal: ActionIntentJournal,
  registry: ToolRegistry,
  probe?: ReconciliationProbe,
): Promise<ReconciliationDecision[]> {
  const decisions: ReconciliationDecision[] = [];
  for (const intent of journal.unresolved()) {
    decisions.push(await reconcileIntent(intent, registry, probe));
  }
  return decisions;
}
