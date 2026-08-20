import type {
  CapabilityId,
  DomainStatusMapping,
  NodeRecord,
} from "@universal-harness-internal/core";

import { readFindingGovernance } from "../finding/governance.js";

/**
 * Module-owned domain status projection (plan T10, slim-profiles design
 * 7.5): each active pipeline module registers its finer domain states with
 * the shared projector and this module derives the current state from
 * committed graph facts only — never from wishes, run logs or UI guesses.
 * Absent evidence maps to `controlled_not_applicable`, unfinished or failed
 * proof to `invalid_or_incomplete`; nothing here ever invents `proven`.
 */
export const MODULE_STATUS_MAPPINGS: readonly DomainStatusMapping[] = [
  {
    capability_id: "impact_analysis",
    mappings: {
      impact_set_approved: "proven",
      impact_set_proposed: "invalid_or_incomplete",
      impact_set_not_started: "controlled_not_applicable",
    },
  },
  {
    capability_id: "independent_evaluation",
    mappings: {
      evaluation_passed: "proven",
      evaluation_failed: "invalid_or_incomplete",
      evaluation_provisional: "invalid_or_incomplete",
      evaluation_not_started: "controlled_not_applicable",
    },
  },
  {
    capability_id: "advanced_audit",
    mappings: {
      audit_clean: "proven",
      audit_warnings_open: "proven",
      audit_blockers_open: "invalid_or_incomplete",
      audit_not_started: "controlled_not_applicable",
    },
  },
];

const MODULE_CAPABILITIES = [
  "impact_analysis",
  "independent_evaluation",
  "advanced_audit",
] as const;
export type ModuleStatusCapabilityId = (typeof MODULE_CAPABILITIES)[number];

export function isModuleStatusCapability(
  capabilityId: CapabilityId,
): capabilityId is ModuleStatusCapabilityId {
  return (MODULE_CAPABILITIES as readonly string[]).includes(capabilityId);
}

/** Latest non-tombstoned revision per node id. */
function currentNodes(nodes: readonly NodeRecord[]): NodeRecord[] {
  const latest = new Map<string, NodeRecord>();
  for (const node of nodes) {
    const existing = latest.get(node.id);
    if (existing === undefined || node.revision > existing.revision) latest.set(node.id, node);
  }
  return [...latest.values()].filter((node) => node.status !== "tombstoned");
}

function deriveImpactStatus(nodes: readonly NodeRecord[]): string {
  const sets = currentNodes(nodes).filter((node) => node.type === "ImpactSet");
  if (sets.length === 0) return "impact_set_not_started";
  return sets.some((node) => node.status === "accepted")
    ? "impact_set_approved"
    : "impact_set_proposed";
}

function deriveEvaluationStatus(nodes: readonly NodeRecord[]): string {
  const evidence = currentNodes(nodes).filter(
    (node) =>
      (node.type === "Evidence" || node.type === "EvaluationCase") &&
      node.extensions?.["harness.evaluation"] !== undefined,
  );
  if (evidence.length === 0) return "evaluation_not_started";
  if (evidence.some((node) => node.status === "proposed")) return "evaluation_provisional";
  const failed = evidence.some((node) => {
    const extension = node.extensions?.["harness.evaluation"];
    return (
      typeof extension === "object" &&
      extension !== null &&
      (extension as Record<string, unknown>)["passed"] === false
    );
  });
  return failed ? "evaluation_failed" : "evaluation_passed";
}

function deriveAuditStatus(nodes: readonly NodeRecord[]): string {
  const findings = currentNodes(nodes).filter(
    (node) => node.type === "Finding" && node.source === "audit",
  );
  if (findings.length === 0) return "audit_not_started";
  const open = findings.filter((node) => node.status === "proposed" || node.status === "accepted");
  if (open.some((node) => readFindingGovernance(node).severity === "blocker")) {
    return "audit_blockers_open";
  }
  return open.length > 0 ? "audit_warnings_open" : "audit_clean";
}

/** The current domain status of one module, derived from graph facts only. */
export function deriveModuleDomainStatus(
  capabilityId: ModuleStatusCapabilityId,
  nodes: readonly NodeRecord[],
): string {
  if (capabilityId === "impact_analysis") return deriveImpactStatus(nodes);
  if (capabilityId === "independent_evaluation") return deriveEvaluationStatus(nodes);
  return deriveAuditStatus(nodes);
}
