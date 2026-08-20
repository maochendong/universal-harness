import { contentDigest } from "../identity/digest.js";

/**
 * The allowlisted Policy clause registry data contract (prompt governance
 * addendum design 6.3). PG-0 pins only the data: clause ids, versions and
 * digests. PG-1 compiles clauses into prompts; raw Policy Markdown never
 * becomes an instruction. Unknown clause ids fail closed.
 */
export const PROMPT_POLICY_CLAUSE_IDS = [
  "require_security_negative_paths",
  "require_migration_analysis",
  "require_reviewer_segregation",
  "require_compliance_traceability",
] as const;
export type PromptPolicyClauseId = (typeof PROMPT_POLICY_CLAUSE_IDS)[number];

export interface PromptPolicyClause {
  readonly clause_id: PromptPolicyClauseId;
  readonly clause_version: string;
  readonly clause_digest: string;
}

export class PromptPolicyClauseError extends Error {
  readonly clause_id: string;

  constructor(clauseId: string) {
    super(`Unknown prompt policy clause: ${clauseId}`);
    this.name = "PromptPolicyClauseError";
    this.clause_id = clauseId;
  }
}

function defineClause(clauseId: PromptPolicyClauseId, clauseVersion: string): PromptPolicyClause {
  return {
    clause_id: clauseId,
    clause_version: clauseVersion,
    clause_digest: contentDigest({ clause_id: clauseId, clause_version: clauseVersion }),
  };
}

export const PROMPT_POLICY_CLAUSES: readonly PromptPolicyClause[] = Object.freeze(
  PROMPT_POLICY_CLAUSE_IDS.map((clauseId) => defineClause(clauseId, "1.0.0")),
);

export function isPromptPolicyClauseId(value: unknown): value is PromptPolicyClauseId {
  return (
    typeof value === "string" && (PROMPT_POLICY_CLAUSE_IDS as readonly string[]).includes(value)
  );
}

/** Fail-closed lookup: unregistered clauses are rejected, never ignored. */
export function promptPolicyClause(clauseId: string): PromptPolicyClause {
  const clause = PROMPT_POLICY_CLAUSES.find((candidate) => candidate.clause_id === clauseId);
  if (clause === undefined) {
    throw new PromptPolicyClauseError(clauseId);
  }
  return clause;
}
