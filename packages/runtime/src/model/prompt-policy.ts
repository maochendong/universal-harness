import {
  PromptPolicyClauseError,
  contentDigest,
  promptPolicyClause,
  type PromptPolicyClause,
} from "@universal-harness-internal/core";

/**
 * Structured Policy overlay compilation (prompt governance addendum design
 * 6.3). A Policy may only contribute allowlisted clause ids with strict
 * parameters — raw Policy Markdown never becomes an instruction. Unknown
 * clauses, illegal parameters and any attempt to retarget the authority
 * boundary, role or output schema fail closed with `policy_overlay_invalid`.
 */
export interface PromptPolicyOverlayClause {
  readonly clause_id: string;
  readonly params?: Readonly<Record<string, string>>;
}

export class PromptPolicyOverlayError extends Error {
  readonly code = "policy_overlay_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "PromptPolicyOverlayError";
  }
}

/** Parameter keys that would retarget Harness-owned sections. */
const FORBIDDEN_PARAM_KEYS: ReadonlySet<string> = new Set([
  "authority_boundary",
  "role_instruction",
  "domain_rubric",
  "profile_overlay",
  "output_schema",
  "output_contract",
  "system_prompt",
  "developer_prompt",
  "tool_prompt",
  "prompt",
]);

const PARAM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;
const MAX_PARAM_VALUE_LENGTH = 200;

function assertParamsValid(params: Readonly<Record<string, string>> | undefined): void {
  if (params === undefined) return;
  for (const [key, value] of Object.entries(params)) {
    if (!PARAM_KEY_PATTERN.test(key) || FORBIDDEN_PARAM_KEYS.has(key)) {
      throw new PromptPolicyOverlayError(
        `illegal policy clause parameter key; overlays can never retarget authority, role or output sections`,
      );
    }
    if (value.length === 0 || value.length > MAX_PARAM_VALUE_LENGTH) {
      throw new PromptPolicyOverlayError(
        `illegal policy clause parameter value length for key ${key}`,
      );
    }
  }
}

export interface CompiledPolicyOverlay {
  readonly content: string;
  readonly overlay_digest: string;
}

const NO_CLAUSES_CONTENT = "No policy clauses are active for this invocation." as const;

/**
 * Compile the overlay deterministically: clauses are sorted by id, duplicates
 * are ambiguous and rejected, and every line pins the clause id, version and
 * registry digest.
 */
export function compilePolicyOverlay(
  clauses: readonly PromptPolicyOverlayClause[],
): CompiledPolicyOverlay {
  const resolved: { clause: PromptPolicyClause; params: Readonly<Record<string, string>> }[] = [];
  const seen = new Set<string>();
  for (const input of clauses) {
    let clause: PromptPolicyClause;
    try {
      clause = promptPolicyClause(input.clause_id);
    } catch (error) {
      if (error instanceof PromptPolicyClauseError) {
        throw new PromptPolicyOverlayError(
          `unregistered policy clause id; the overlay allowlist is closed`,
        );
      }
      throw error;
    }
    if (seen.has(clause.clause_id)) {
      throw new PromptPolicyOverlayError(
        `duplicate policy clause ${clause.clause_id} in one overlay`,
      );
    }
    seen.add(clause.clause_id);
    assertParamsValid(input.params);
    resolved.push({ clause, params: input.params ?? {} });
  }
  resolved.sort((left, right) => left.clause.clause_id.localeCompare(right.clause.clause_id));

  const lines = resolved.map(({ clause, params }) => {
    const renderedParams = Object.entries(params)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    return `- ${clause.clause_id}@${clause.clause_version} (digest ${clause.clause_digest})${renderedParams.length > 0 ? `: ${renderedParams}` : ""}`;
  });
  const content = lines.length === 0 ? NO_CLAUSES_CONTENT : lines.join("\n");
  return {
    content,
    overlay_digest: contentDigest({ kind: "policy_overlay", lines }),
  };
}
