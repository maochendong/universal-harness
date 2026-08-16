import type { LifecycleEvent } from "@universal-harness-internal/core";

/**
 * Phase lifecycle events (design 2, plan Task 23 step 4). Every committed
 * phase is bracketed by ordered lifecycle events drawn from the fixed event
 * vocabulary in the core schema; the orchestrator emits them as part of the
 * phase's own atomic ledger commit, so an event never exists without the
 * phase output it describes. This is an internal emission contract only --
 * no public hook SDK is exposed.
 */
export interface PhaseLifecycleEventSpec {
  readonly eventType: LifecycleEvent["event_type"];
  readonly payload: Record<string, unknown>;
}

/** Per-phase event payloads; each variant carries exactly what its events report. */
export type PhaseLifecycleDetails =
  | { readonly phase: "capture"; readonly baselineDigest: string }
  | { readonly phase: "impact"; readonly impactSetId: string; readonly entries: number }
  | {
      readonly phase: "plan";
      readonly planId: string;
      readonly mode: string;
      readonly tasks: number;
    }
  | {
      readonly phase: "context";
      readonly contextBundleId: string;
      readonly contextBundleDigest: string;
      readonly includedTokens: number;
    }
  | {
      readonly phase: "execute";
      readonly taskId: string;
      readonly runId: string;
      readonly outcome: string;
    }
  | {
      readonly phase: "verify";
      readonly gates: readonly {
        readonly gateId: string;
        readonly passed: boolean;
        readonly observationKey?: string;
      }[];
    }
  | {
      readonly phase: "evaluate";
      readonly caseId: string;
      readonly passed: boolean;
      readonly findingIds: readonly string[];
    }
  | { readonly phase: "snapshot"; readonly snapshotId: string; readonly status: string };

/**
 * Ordered lifecycle events for one committed phase. Within a phase the
 * emission order is fixed (for example BeforeContextCompile always precedes
 * ContextCompiled); the Workflow Engine assigns the ledger-wide sequence
 * numbers when the phase commits.
 */
export function phaseLifecycleEvents(details: PhaseLifecycleDetails): PhaseLifecycleEventSpec[] {
  switch (details.phase) {
    case "capture":
      return [];
    case "impact":
      return [];
    case "plan":
      return [
        {
          eventType: "PlanAccepted",
          payload: { plan_id: details.planId, mode: details.mode, tasks: details.tasks },
        },
      ];
    case "context":
      return [
        {
          eventType: "BeforeContextCompile",
          payload: { context_bundle_id: details.contextBundleId },
        },
        {
          eventType: "ContextCompiled",
          payload: {
            context_bundle_id: details.contextBundleId,
            context_bundle_digest: details.contextBundleDigest,
            included_tokens: details.includedTokens,
          },
        },
      ];
    case "execute":
      return [];
    case "verify":
      return details.gates.map((gate) => ({
        eventType: "GateCompleted" as const,
        payload: {
          gate_id: gate.gateId,
          passed: gate.passed,
          ...(gate.observationKey === undefined ? {} : { observation_key: gate.observationKey }),
        },
      }));
    case "evaluate":
      return [
        {
          eventType: "EvaluationCompleted",
          payload: { case_id: details.caseId, passed: details.passed },
        },
        ...details.findingIds.map((findingId) => ({
          eventType: "FindingCreated" as const,
          payload: { finding_id: findingId, origin: "evaluation" },
        })),
      ];
    case "snapshot":
      return [];
  }
}

/**
 * Verify the lifecycle events of one workflow operation are strictly ordered
 * by sequence. Replay order is append-only; any gap in monotonicity means the
 * ledger was tampered with or replayed incorrectly.
 */
export function assertLifecycleOrder(events: readonly LifecycleEvent[]): void {
  let previous = 0;
  for (const event of events) {
    if (event.sequence <= previous) {
      throw new Error(
        `lifecycle events for ${event.workflow_operation_id} are not ordered: ` +
          `sequence ${String(event.sequence)} follows ${String(previous)}`,
      );
    }
    previous = event.sequence;
  }
}
