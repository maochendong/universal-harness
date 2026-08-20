import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import {
  PROJECT_CONTEXT_INVALIDATION_REASONS,
  PROJECT_CONTEXT_PURPOSES,
  PROJECT_CONTEXT_SOURCE_KINDS,
  type ProjectContextBudget,
  type ProjectContextBundleInvalidationRecord,
  type ProjectContextBundleRecord,
  type ProjectContextExclusion,
  type ProjectContextInvalidationReason,
  type ProjectContextPurpose,
  type ProjectContextSource,
} from "../schema/context.js";
import { sealRecordEnvelope } from "../schema/envelope.js";

/**
 * Constructors for the Protocol 1.1 project context records (intent-to-prd
 * design 6.3). Identity is derived deterministically: the same session,
 * purpose and content always produce the same bundle, while a purpose change
 * always produces a fresh identity — which is what makes Proposal/Review
 * bundle reuse mechanically impossible.
 */
export class ProjectContextError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ProjectContextError";
    this.kind = kind;
  }
}

const DIGEST_REGEX = /^[a-f0-9]{64}$/u;

function assertDigest(kind: string, value: string, field: string): void {
  if (!DIGEST_REGEX.test(value)) {
    throw new ProjectContextError(kind, `${field} must be a lowercase sha-256 hex digest`);
  }
}

function canonicalSources(sources: readonly ProjectContextSource[]): ProjectContextSource[] {
  const sorted = [...sources].sort((left, right) =>
    left.locator < right.locator ? -1 : left.locator > right.locator ? 1 : 0,
  );
  const locators = new Set<string>();
  for (const source of sorted) {
    if (!PROJECT_CONTEXT_SOURCE_KINDS.includes(source.source_kind)) {
      throw new ProjectContextError(
        "invalid_source",
        `unknown source kind: ${String(source.source_kind)}`,
      );
    }
    assertDigest("invalid_source", source.source_digest, `source digest for ${source.locator}`);
    if (locators.has(source.locator)) {
      throw new ProjectContextError(
        "duplicate_locator",
        `duplicate source locator: ${source.locator}`,
      );
    }
    locators.add(source.locator);
  }
  return sorted;
}

function canonicalExclusions(
  exclusions: readonly ProjectContextExclusion[],
): ProjectContextExclusion[] {
  return [...exclusions].sort((left, right) =>
    left.locator === right.locator
      ? left.reason < right.reason
        ? -1
        : 1
      : left.locator < right.locator
        ? -1
        : 1,
  );
}

function assertBudget(budget: ProjectContextBudget): void {
  for (const [field, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ProjectContextError("invalid_budget", `budget ${field} must be a positive integer`);
    }
  }
}

export interface CreateProjectContextBundleInput {
  readonly session_id: string;
  readonly purpose: ProjectContextPurpose;
  readonly project_baseline_digest: string;
  readonly profile_digest: string;
  readonly policy_digest: string;
  readonly budget: ProjectContextBudget;
  readonly sources: readonly ProjectContextSource[];
  readonly exclusions: readonly ProjectContextExclusion[];
}

export function createProjectContextBundleRecord(
  input: CreateProjectContextBundleInput,
): ProjectContextBundleRecord {
  if (!PROJECT_CONTEXT_PURPOSES.includes(input.purpose)) {
    throw new ProjectContextError("invalid_purpose", `unknown purpose: ${String(input.purpose)}`);
  }
  assertDigest("invalid_digest", input.project_baseline_digest, "project_baseline_digest");
  assertDigest("invalid_digest", input.profile_digest, "profile_digest");
  assertDigest("invalid_digest", input.policy_digest, "policy_digest");
  assertBudget(input.budget);
  const sources = canonicalSources(input.sources);
  const exclusions = canonicalExclusions(input.exclusions);
  const content_digest = contentDigest({
    purpose: input.purpose,
    project_baseline_digest: input.project_baseline_digest,
    profile_digest: input.profile_digest,
    policy_digest: input.policy_digest,
    budget: input.budget,
    sources,
    exclusions,
  });
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "project_context_bundle" as const,
    bundle_id: domainRecordId({
      domain_tag: "project_context_bundle",
      id_prefix: "project-context-bundle",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        session_id: input.session_id,
        purpose: input.purpose,
        content_digest,
      },
    }),
    session_id: input.session_id,
    purpose: input.purpose,
    project_baseline_digest: input.project_baseline_digest,
    profile_digest: input.profile_digest,
    policy_digest: input.policy_digest,
    budget: input.budget,
    sources,
    exclusions,
    content_digest,
  });
}

/**
 * Append-only invalidation fact (design 14.2/18). Identity binds the bundle
 * digest and the reason set, so re-recording the same drift is a no-op.
 */
export function createProjectContextBundleInvalidationRecord(input: {
  readonly bundle: ProjectContextBundleRecord;
  readonly reasons: readonly ProjectContextInvalidationReason[];
}): ProjectContextBundleInvalidationRecord {
  const reasons = [...new Set(input.reasons)].sort();
  if (
    reasons.length === 0 ||
    !reasons.every((reason) => PROJECT_CONTEXT_INVALIDATION_REASONS.includes(reason))
  ) {
    throw new ProjectContextError(
      "invalid_invalidation",
      "invalidation reasons must be a non-empty subset of the registered reasons",
    );
  }
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "project_context_bundle_invalidation" as const,
    invalidation_id: domainRecordId({
      domain_tag: "project_context_bundle_invalidation",
      id_prefix: "context-bundle-invalidation",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { bundle_digest: input.bundle.record_digest, reasons },
    }),
    bundle_id: input.bundle.bundle_id,
    bundle_digest: input.bundle.record_digest,
    reasons,
  });
}
