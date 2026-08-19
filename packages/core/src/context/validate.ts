import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import { verifyRecordEnvelope } from "../schema/envelope.js";
import type {
  ProjectContextBundleRecord,
  ProjectContextInvalidationReason,
} from "../schema/context.js";
import { ProjectContextError } from "./records.js";
import type { ProjectContextRequest } from "./port.js";
import { hasUnsafeText, isLocatorAllowedByPolicy, isSafeRelativeLocator } from "./policy.js";

/**
 * Harness-side acceptance gate (intent-to-prd design 8.1): an adapter's
 * bundle is only accepted after the Harness re-validates the locator policy,
 * source kinds, digests, classification, budget and baseline bindings. A
 * malicious or buggy adapter cannot smuggle traversal paths, unsanitized
 * text or disallowed kinds past this gate.
 */
export const BUNDLE_REJECTION_CODES = [
  "schema_invalid",
  "session_mismatch",
  "purpose_mismatch",
  "baseline_mismatch",
  "profile_mismatch",
  "policy_mismatch",
  "source_kind_not_allowed",
  "unsafe_locator",
  "unsanitized_summary",
  "budget_exceeded",
] as const;
export type BundleRejectionCode = (typeof BUNDLE_REJECTION_CODES)[number];

export type BundleAcceptance =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly code: BundleRejectionCode; readonly message: string };

function rejected(code: BundleRejectionCode, message: string): BundleAcceptance {
  return { status: "rejected", code, message };
}

export function acceptProjectContextBundle(
  request: ProjectContextRequest,
  bundle: ProjectContextBundleRecord,
): BundleAcceptance {
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("project-context-bundle", bundle);
  if (!validation.valid || !verifyRecordEnvelope(bundle as unknown as Record<string, unknown>)) {
    return rejected("schema_invalid", "bundle failed schema or envelope validation");
  }
  if (bundle.session_id !== request.session_id) {
    return rejected("session_mismatch", "bundle session does not match the request");
  }
  if (bundle.purpose !== request.purpose) {
    return rejected("purpose_mismatch", "bundle purpose does not match the request");
  }
  if (bundle.project_baseline_digest !== request.project_baseline_digest) {
    return rejected("baseline_mismatch", "bundle baseline digest does not match the request");
  }
  if (bundle.profile_digest !== request.project_profile_digest) {
    return rejected("profile_mismatch", "bundle profile digest does not match the request");
  }
  if (bundle.policy_digest !== request.capture_policy_digest) {
    return rejected("policy_mismatch", "bundle policy digest does not match the request");
  }
  if (bundle.sources.length > request.budget.max_files) {
    return rejected("budget_exceeded", "bundle carries more sources than the budget allows");
  }
  for (const source of bundle.sources) {
    if (!request.allowed_source_kinds.includes(source.source_kind)) {
      return rejected(
        "source_kind_not_allowed",
        `source kind ${source.source_kind} is not allowed by this request`,
      );
    }
    if (
      !isSafeRelativeLocator(source.locator) ||
      !isLocatorAllowedByPolicy(source.locator, request.path_policy)
    ) {
      return rejected(
        "unsafe_locator",
        `source locator is outside the path policy: ${source.locator}`,
      );
    }
    if (hasUnsafeText(source.summary)) {
      return rejected(
        "unsanitized_summary",
        `source summary still carries control characters: ${source.locator}`,
      );
    }
  }
  return { status: "accepted" };
}

export type BundleFreshness =
  | { readonly status: "fresh" }
  | {
      readonly status: "invalidated";
      readonly reasons: readonly ProjectContextInvalidationReason[];
    };

/**
 * Deterministic drift check (design 18): baseline, profile or policy drift
 * invalidates the bundle and everything compiled from it.
 */
export function validateBundleFreshness(
  bundle: ProjectContextBundleRecord,
  current: {
    readonly project_baseline_digest: string;
    readonly profile_digest: string;
    readonly policy_digest: string;
  },
): BundleFreshness {
  const reasons: ProjectContextInvalidationReason[] = [];
  if (bundle.project_baseline_digest !== current.project_baseline_digest) {
    reasons.push("baseline_drift");
  }
  if (bundle.profile_digest !== current.profile_digest) {
    reasons.push("profile_drift");
  }
  if (bundle.policy_digest !== current.policy_digest) {
    reasons.push("policy_drift");
  }
  return reasons.length === 0 ? { status: "fresh" } : { status: "invalidated", reasons };
}

/**
 * Proposal/Review independence (design 7.4, 10.2): the two bundles must
 * belong to the same session but never share identity or content digest.
 * Overlapping source files are expected and allowed.
 */
export function assertContextBundleIndependence(
  proposalBundle: ProjectContextBundleRecord,
  reviewBundle: ProjectContextBundleRecord,
): void {
  if (proposalBundle.purpose !== "proposal" || reviewBundle.purpose !== "review") {
    throw new ProjectContextError(
      "bundle_not_independent",
      "independence requires one proposal-purpose and one review-purpose bundle",
    );
  }
  if (proposalBundle.session_id !== reviewBundle.session_id) {
    throw new ProjectContextError(
      "bundle_not_independent",
      "proposal and review bundles must belong to the same capture session",
    );
  }
  if (
    proposalBundle.bundle_id === reviewBundle.bundle_id ||
    proposalBundle.content_digest === reviewBundle.content_digest ||
    proposalBundle.record_digest === reviewBundle.record_digest
  ) {
    throw new ProjectContextError(
      "bundle_not_independent",
      "proposal and review bundles must never share id, content digest or record digest",
    );
  }
}
