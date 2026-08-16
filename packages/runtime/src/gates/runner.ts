import {
  PROTOCOL_VERSION,
  contentDigest,
  validateSchema,
  type FeedbackRecord,
} from "@universal-harness-internal/core";

import type { ToolInvocationContext } from "../tools/invocation.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ObservationPublisherPort } from "../observability/publisher.js";
import { buildGateEvidence, type EvidenceBindings, type GateEvidenceRecord } from "./evidence.js";
import { isEvidenceStale, type CurrentEvidenceState } from "./freshness.js";
import { buildFindingGovernanceMetadata } from "../finding/governance.js";
import {
  GATE_LAYERS,
  GateError,
  runGate,
  type GateDefinition,
  type GateOutcome,
} from "./provider.js";

/**
 * Three-layer gate runner (design 13.6, completion rules 15-16). Gates run in
 * a deterministic order -- universal integrity gates first, then stack
 * profile gates, then project-specific gates -- each through the Tool
 * Registry, each producing a bound Evidence record. A failed mandatory gate
 * appends a proposed Finding and blocks the `completed` state; advisory gate
 * failures are recorded as evidence but block nothing. The runner reports and
 * records; whether a release is allowed stays a policy decision.
 */
export interface GateRunResult {
  readonly gate: GateDefinition;
  readonly outcome: GateOutcome;
  readonly evidence: GateEvidenceRecord;
}

export interface GateSuiteSpec {
  readonly iterationId: string;
  readonly repositoryId: string;
  readonly gates: readonly GateDefinition[];
  /**
   * Inputs every gate in the suite ran against; the runner injects each
   * gate's own definition digest. Arrays compare as sets at freshness time.
   */
  readonly bindings: Omit<EvidenceBindings, "gate_digest">;
  /** ISO timestamp clock; fake in tests. */
  readonly clock: () => string;
  /** Mark all produced evidence provisional (design 10.3 stale-input rule). */
  readonly provisional?: boolean;
  /** Lossy Gate telemetry; never participates in verdict calculation. */
  readonly observations?: Pick<
    ObservationPublisherPort,
    "gateStarted" | "gateCompleted" | "runStarted" | "runHeartbeat" | "runOutput"
  >;
}

export interface GateSuiteOutcome {
  readonly results: readonly GateRunResult[];
  /** One governed proposed Finding per failed gate, in run order. */
  readonly findings: readonly FeedbackRecord[];
  /** True only when every mandatory gate passed with non-provisional evidence. */
  readonly completed_allowed: boolean;
}

function layerRank(gate: GateDefinition): number {
  return GATE_LAYERS.indexOf(gate.layer);
}

/** Deterministic suite order: layer first, then gate id. */
export function orderGates(gates: readonly GateDefinition[]): readonly GateDefinition[] {
  return [...gates].sort((left, right) => {
    const layerDifference = layerRank(left) - layerRank(right);
    if (layerDifference !== 0) return layerDifference;
    return left.gate_id < right.gate_id ? -1 : left.gate_id > right.gate_id ? 1 : 0;
  });
}

function idSuffix(gate: GateDefinition): string {
  return gate.gate_id.slice("gate_".length);
}

const FINDING_SUMMARY_LIMIT = 10_000;

function buildGateFinding(
  spec: GateSuiteSpec,
  gate: GateDefinition,
  outcome: GateOutcome,
): FeedbackRecord {
  const severity = gate.mandatory ? "blocker" : "warning";
  const governance = buildFindingGovernanceMetadata({
    rule: "gate/failure",
    scopePrefix: `project/${spec.repositoryId}/gate/${gate.gate_id}`,
    severity,
    actionability: "human_review",
    subjectIds: [gate.subject_id],
    subjectDigests: [
      ...spec.bindings.artifact_digests,
      ...spec.bindings.code_digests,
      ...spec.bindings.evaluation_case_digests,
      spec.bindings.policy_digest,
      ...(spec.bindings.context_bundle_digest === undefined
        ? []
        : [spec.bindings.context_bundle_digest]),
    ],
  });
  const summary =
    `${gate.mandatory ? "Mandatory" : "Advisory"} ${gate.layer} gate ${gate.gate_id} failed: ${outcome.summary}`.slice(
      0,
      FINDING_SUMMARY_LIMIT,
    );
  const content = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "feedback",
    id: `finding_${idSuffix(gate)}`,
    type: "Finding",
    iteration_id: spec.iterationId,
    status: "proposed",
    summary,
    created_at: spec.clock(),
    extensions: {
      "harness.finding": {
        origin: "test",
        blocking: gate.mandatory,
        violates: [gate.subject_id],
        blocks: gate.mandatory ? [spec.iterationId] : [],
        evidence: [`evidence_${idSuffix(gate)}`],
        ...governance,
      },
    },
  };
  const record = { ...content, digest: contentDigest(content) };
  const validation = validateSchema("feedback", record);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new GateError("invalid_finding_record", `invalid gate finding record: ${detail}`);
  }
  return record as unknown as FeedbackRecord;
}

/**
 * Run the full gate suite in layer order. Every gate runs even when an
 * earlier mandatory gate failed, so the iteration sees the complete picture;
 * failures never throw, they land in the outcome as failed results.
 */
export async function runGateSuite(
  registry: ToolRegistry,
  spec: GateSuiteSpec,
  invocation?: ToolInvocationContext,
): Promise<GateSuiteOutcome> {
  const results: GateRunResult[] = [];
  const findings: FeedbackRecord[] = [];
  for (const gate of orderGates(spec.gates)) {
    try {
      spec.observations?.gateStarted(gate.gate_id);
    } catch {
      // Observation delivery is intentionally non-authoritative.
    }
    const outcome = await runGate(registry, gate, {
      intentId: `intent_${idSuffix(gate)}`,
      ...(invocation === undefined && spec.observations === undefined
        ? {}
        : {
            invocation: {
              ...(invocation ?? {}),
              ...(invocation?.observations !== undefined
                ? {}
                : spec.observations === undefined
                  ? {}
                  : { observations: spec.observations }),
            },
          }),
    });
    try {
      spec.observations?.gateCompleted(gate.gate_id, {
        passed: outcome.passed,
        mandatory: gate.mandatory,
        output_digest: outcome.output_digest,
        summary: outcome.summary,
      });
    } catch {
      // The authoritative GateCompleted event is committed by the orchestrator.
    }
    const evidence = buildGateEvidence({
      evidenceId: `evidence_${idSuffix(gate)}`,
      createdAt: spec.clock(),
      ...(spec.provisional === true ? { provisional: true } : {}),
      outcome,
      bindings: { ...spec.bindings, gate_digest: gate.digest },
    });
    results.push({ gate, outcome, evidence });
    if (!outcome.passed) {
      findings.push(buildGateFinding(spec, gate, outcome));
    }
  }
  const completedAllowed = results.every(
    (result) => !result.gate.mandatory || (result.outcome.passed && !result.evidence.provisional),
  );
  return { results, findings, completed_allowed: completedAllowed };
}

/**
 * Every reason the suite cannot support a `completed` state (design 9
 * Snapshot rules): a failed mandatory gate, provisional mandatory evidence,
 * or -- when current authoritative digests are supplied -- stale mandatory
 * evidence. Advisory results never block.
 */
export function completionBlockers(
  outcome: GateSuiteOutcome,
  currentFor?: (gate: GateDefinition) => CurrentEvidenceState,
): readonly string[] {
  const blockers: string[] = [];
  for (const result of outcome.results) {
    if (!result.gate.mandatory) continue;
    if (!result.outcome.passed) {
      blockers.push(`mandatory gate ${result.gate.gate_id} failed: ${result.outcome.summary}`);
      continue;
    }
    if (result.evidence.provisional) {
      blockers.push(`mandatory gate ${result.gate.gate_id} evidence is provisional`);
      continue;
    }
    if (currentFor !== undefined && isEvidenceStale(result.evidence, currentFor(result.gate))) {
      blockers.push(`mandatory gate ${result.gate.gate_id} evidence is stale`);
    }
  }
  return blockers;
}
