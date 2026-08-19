import { contentDigest } from "../identity/digest.js";
import type { ProjectContextExclusion, ProjectContextSource } from "../schema/context.js";
import { PROJECT_CONTEXT_CANDIDATE_PATHS } from "./source-kinds.js";
import type { ProjectContextRequest } from "./port.js";
import {
  containsSecretContent,
  isLocatorAllowedByPolicy,
  isSafeRelativeLocator,
  isSecretLocator,
  looksBinaryContent,
  sanitizeContextText,
} from "./policy.js";

/**
 * Shared deterministic candidate pipeline for every ProjectContext adapter
 * (intent-to-prd design 8.2). The accessor abstracts where bytes come from
 * (a local git work tree or an in-memory map); the defense order is fixed:
 * locator policy → secret name → existence → symlink escape → trackedness →
 * binary → oversize → secret content → sanitize → budget.
 */
export interface ContextFileProbe {
  readonly exists: boolean;
  /** True when resolving the locator lands outside the project root. */
  readonly symlinkEscaped: boolean;
  /** False when the file exists on disk but is not part of the tracked project. */
  readonly tracked: boolean;
  readonly size: number;
}

export interface ContextFileAccessor {
  probe(locator: string): ContextFileProbe;
  /** Called only for probes that passed every earlier defense. */
  read(locator: string): Uint8Array;
}

export interface CollectedContext {
  readonly sources: ProjectContextSource[];
  readonly exclusions: ProjectContextExclusion[];
}

export function collectContextSources(
  accessor: ContextFileAccessor,
  request: ProjectContextRequest,
): CollectedContext {
  const sources: ProjectContextSource[] = [];
  const exclusions: ProjectContextExclusion[] = [];
  let totalBytes = 0;

  const kinds = [...request.allowed_source_kinds].sort();
  for (const kind of kinds) {
    const candidates = PROJECT_CONTEXT_CANDIDATE_PATHS[kind];
    if (candidates === undefined) continue;
    for (const locator of candidates) {
      if (sources.length >= request.budget.max_files) {
        exclusions.push({ locator, reason: "budget_exceeded" });
        continue;
      }
      if (
        !isSafeRelativeLocator(locator) ||
        !isLocatorAllowedByPolicy(locator, request.path_policy)
      ) {
        exclusions.push({ locator, reason: "path_policy_denied" });
        continue;
      }
      if (isSecretLocator(locator)) {
        exclusions.push({ locator, reason: "secret_pattern" });
        continue;
      }
      let probe: ContextFileProbe;
      try {
        probe = accessor.probe(locator);
      } catch {
        continue; // Not present at all: no candidate matched, nothing to audit.
      }
      if (!probe.exists) continue;
      if (probe.symlinkEscaped) {
        exclusions.push({ locator, reason: "symlink_escape" });
        continue;
      }
      if (!probe.tracked) {
        exclusions.push({ locator, reason: "untracked" });
        continue;
      }
      if (probe.size > request.budget.max_bytes_per_source) {
        exclusions.push({ locator, reason: "oversize" });
        continue;
      }
      if (totalBytes + probe.size > request.budget.max_total_bytes) {
        exclusions.push({ locator, reason: "budget_exceeded" });
        continue;
      }
      let content: Uint8Array;
      try {
        content = accessor.read(locator);
      } catch {
        exclusions.push({ locator, reason: "unreadable" });
        continue;
      }
      if (looksBinaryContent(content)) {
        exclusions.push({ locator, reason: "binary" });
        continue;
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(content);
      if (containsSecretContent(text)) {
        exclusions.push({ locator, reason: "secret_pattern" });
        continue;
      }
      const sanitized = sanitizeContextText(text);
      const truncated = sanitized.length > request.budget.max_summary_chars;
      const summary = truncated ? sanitized.slice(0, request.budget.max_summary_chars) : sanitized;
      sources.push({
        locator,
        source_kind: kind,
        source_digest: contentDigest(text),
        selection_reason: `matched default candidate for source kind ${kind}`,
        classification: "internal_project",
        summary,
        truncated,
      });
      totalBytes += probe.size;
    }
  }
  return { sources, exclusions };
}
