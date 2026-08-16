import type { NodeRecord } from "@universal-harness-internal/core";

import type { AuditFinding, AuditFindingKind } from "../audit/auditor.js";

export const FINDING_SEVERITIES = ["blocker", "warning"] as const;
export const FINDING_ACTIONABILITIES = ["auto_close", "human_review", "upstream_change"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type FindingActionability = (typeof FINDING_ACTIONABILITIES)[number];

export interface FindingGovernanceMetadata {
  readonly rule: string;
  readonly scope_prefix: string;
  readonly severity: FindingSeverity;
  readonly actionability: FindingActionability;
  readonly subject_ids: readonly string[];
  readonly subject_digests: readonly string[];
}

export interface FindingGovernanceInput {
  readonly rule: string;
  readonly scopePrefix: string;
  readonly severity: FindingSeverity;
  readonly actionability: FindingActionability;
  readonly subjectIds?: readonly string[];
  readonly subjectDigests?: readonly string[];
}

export class FindingGovernanceError extends Error {
  readonly kind = "invalid_finding_governance" as const;

  constructor(message: string) {
    super(message);
    this.name = "FindingGovernanceError";
  }
}

interface AuditGovernanceRule {
  readonly domain: string;
  readonly actionability: FindingActionability;
}

const AUDIT_GOVERNANCE_RULES = {
  traceability_gap: { domain: "traceability", actionability: "auto_close" },
  stale_knowledge: { domain: "knowledge", actionability: "auto_close" },
  contradictory_constraint: { domain: "requirements", actionability: "human_review" },
  orphan_node: { domain: "graph", actionability: "human_review" },
  missing_verification: { domain: "verification", actionability: "auto_close" },
  unpromoted_high_risk_improvement: {
    domain: "improvement",
    actionability: "human_review",
  },
  unhealthy_context_source: { domain: "context", actionability: "upstream_change" },
  missing_design_artifact: { domain: "design", actionability: "auto_close" },
  task_orphan: { domain: "plan", actionability: "auto_close" },
  api_contract_coverage: { domain: "design", actionability: "auto_close" },
  task_stale: { domain: "execution", actionability: "auto_close" },
} as const satisfies Readonly<Record<AuditFindingKind, AuditGovernanceRule>>;

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function assertLabel(field: string, value: string): void {
  const containsControlCharacter = [...value].some((character) => character.charCodeAt(0) < 32);
  if (value.length === 0 || value.length > 500 || containsControlCharacter) {
    throw new FindingGovernanceError(`${field} must be a non-empty stable label`);
  }
}

/** Normalize the version-1 governance metadata shared by all Finding producers. */
export function buildFindingGovernanceMetadata(
  input: FindingGovernanceInput,
): FindingGovernanceMetadata {
  assertLabel("rule", input.rule);
  assertLabel("scope prefix", input.scopePrefix);
  if (!FINDING_SEVERITIES.includes(input.severity)) {
    throw new FindingGovernanceError(`unknown finding severity ${String(input.severity)}`);
  }
  if (!FINDING_ACTIONABILITIES.includes(input.actionability)) {
    throw new FindingGovernanceError(
      `unknown finding actionability ${String(input.actionability)}`,
    );
  }
  const subjectIds = stableUnique(input.subjectIds ?? []);
  const subjectDigests = stableUnique(input.subjectDigests ?? []);
  for (const subjectId of subjectIds) assertLabel("subject id", subjectId);
  for (const digest of subjectDigests) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      throw new FindingGovernanceError(`subject digest ${digest} must be lowercase sha-256`);
    }
  }
  return {
    rule: input.rule,
    scope_prefix: input.scopePrefix,
    severity: input.severity,
    actionability: input.actionability,
    subject_ids: subjectIds,
    subject_digests: subjectDigests,
  };
}

/** Producer metadata for one deterministic graph-audit Finding. */
export function findingGovernanceForAudit(
  finding: Pick<AuditFinding, "kind" | "subjects" | "blocking">,
  repositoryId: string,
  subjectDigests: readonly string[] = [],
): FindingGovernanceMetadata {
  assertLabel("repository id", repositoryId);
  const policy = AUDIT_GOVERNANCE_RULES[finding.kind];
  return buildFindingGovernanceMetadata({
    rule: `audit/${finding.kind}`,
    scopePrefix: `project/${repositoryId}/${policy.domain}`,
    severity: finding.blocking ? "blocker" : "warning",
    actionability: policy.actionability,
    subjectIds: finding.subjects,
    subjectDigests,
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function isSeverity(value: unknown): value is FindingSeverity {
  return typeof value === "string" && FINDING_SEVERITIES.includes(value as FindingSeverity);
}

function isActionability(value: unknown): value is FindingActionability {
  return (
    typeof value === "string" && FINDING_ACTIONABILITIES.includes(value as FindingActionability)
  );
}

/**
 * Read current governance metadata. Legacy records deliberately fall back to
 * an explicit unknown group until the versioned adapter can classify them.
 */
export function readFindingGovernance(node: NodeRecord): FindingGovernanceMetadata {
  const extension = recordValue(node.extensions?.["harness.finding"]);
  const rule = extension?.["rule"];
  const scopePrefix = extension?.["scope_prefix"];
  const severity = extension?.["severity"];
  const actionability = extension?.["actionability"];
  const subjectIds = stringArray(extension?.["subject_ids"]);
  const subjectDigests = stringArray(extension?.["subject_digests"]);
  if (
    typeof rule === "string" &&
    typeof scopePrefix === "string" &&
    isSeverity(severity) &&
    isActionability(actionability) &&
    subjectIds !== undefined &&
    subjectDigests !== undefined
  ) {
    try {
      return buildFindingGovernanceMetadata({
        rule,
        scopePrefix,
        severity,
        actionability,
        subjectIds,
        subjectDigests,
      });
    } catch {
      // Invalid producer metadata is isolated in the safe legacy group.
    }
  }
  const blocking = extension?.["blocking"] !== false;
  const audit = recordValue(node.extensions?.["harness.audit"]);
  const auditKind = audit?.["kind"];
  const auditSubjects = stringArray(audit?.["subjects"]);
  if (
    extension?.["origin"] === "audit" &&
    typeof auditKind === "string" &&
    Object.hasOwn(AUDIT_GOVERNANCE_RULES, auditKind) &&
    auditSubjects !== undefined
  ) {
    const kind = auditKind as AuditFindingKind;
    const policy = AUDIT_GOVERNANCE_RULES[kind];
    return buildFindingGovernanceMetadata({
      rule: `audit/${kind}`,
      scopePrefix: `legacy/audit/${policy.domain}`,
      severity: blocking ? "blocker" : "warning",
      actionability: policy.actionability,
      subjectIds: auditSubjects,
    });
  }
  return buildFindingGovernanceMetadata({
    rule: "legacy/unknown",
    scopePrefix: "legacy/unknown",
    severity: blocking ? "blocker" : "warning",
    actionability: "human_review",
  });
}
