import { estimateTokens } from "./budget.js";
import { ContextError } from "./selector.js";

/**
 * Pluggable context compression (design 13.4). A compressor reduces one
 * source's content to a token ceiling but must never remove protected
 * content: Goal, Acceptance Criteria, Safety Constraints, Active Approvals
 * and unresolved blockers survive any budget. Protected content may exceed
 * the ceiling — it is exempt by design — and the size change is always
 * recorded so the manifest can report original versus included tokens.
 */
export interface CompressionResult {
  readonly content: string;
  readonly method: string;
  readonly originalTokens: number;
  readonly includedTokens: number;
}

export interface Compressor {
  readonly id: string;
  compress(
    content: string,
    maxTokens: number,
    protectedFields: readonly string[],
  ): CompressionResult;
}

export const NO_COMPRESSION = "none";
export const TRUNCATE_COMPRESSOR_ID = "truncate-v1";

/** Protected fields must be verbatim spans of the source content. */
export function assertProtectedFieldsPresent(
  nodeId: string,
  content: string,
  protectedFields: readonly string[],
): void {
  for (const field of protectedFields) {
    if (field.length === 0 || !content.includes(field)) {
      throw new ContextError(
        "invalid_source",
        `protected field of source ${nodeId} is not a verbatim span of its content`,
      );
    }
  }
}

/**
 * Deterministic M1 compressor. Content that fits passes through unchanged
 * (`none`). Otherwise lines carrying a protected field are always kept and
 * the remaining lines are included greedily in original order until the
 * token ceiling is reached; the output keeps the original line order, so
 * the same input always compresses to the same output.
 */
export function createTruncateCompressor(): Compressor {
  return {
    id: TRUNCATE_COMPRESSOR_ID,
    compress(content, maxTokens, protectedFields) {
      const originalTokens = estimateTokens(content);
      if (originalTokens <= maxTokens) {
        return { content, method: NO_COMPRESSION, originalTokens, includedTokens: originalTokens };
      }
      const lines = content.split("\n");
      const protectedLine = lines.map((line) =>
        protectedFields.some((field) => field.length > 0 && line.includes(field)),
      );
      const included: boolean[] = [...protectedLine];
      let includedTokens = lines.reduce(
        (sum, line, index) => sum + (protectedLine[index] === true ? estimateTokens(line) : 0),
        0,
      );
      for (let index = 0; index < lines.length; index += 1) {
        if (protectedLine[index] === true) continue;
        const line = lines[index];
        if (line === undefined) continue;
        const tokens = estimateTokens(line);
        if (includedTokens + tokens > maxTokens) continue;
        included[index] = true;
        includedTokens += tokens;
      }
      const compressed = lines.filter((_, index) => included[index] === true).join("\n");
      return {
        content: compressed,
        method: TRUNCATE_COMPRESSOR_ID,
        originalTokens,
        includedTokens,
      };
    },
  };
}
