import type { ProjectContextBundleRecord } from "../schema/context.js";
import type {
  GroundedSynthesisRecord,
  ProjectDiscoveryCapabilityCandidate,
  ProjectDiscoveryFact,
  ProjectDiscoveryGateCandidate,
} from "../schema/synthesis.js";
import { validateGroundedCitations } from "./citations.js";
import type { GroundedSynthesisFailure } from "./port.js";

/**
 * The Capture/Capability recommendation consumption contract (model advisory
 * design 10, unified plan T5). Discovery output becomes an advisory
 * recommendation and nothing else: facts, candidate capabilities/gates and
 * confidence, each traceable to the validated record. There is deliberately
 * no path from here to Graph, ProjectProfile or CapabilityPlan writes.
 */
export interface ProjectDiscoveryRecommendation {
  readonly kind: "project_discovery_recommendation";
  readonly advisory: true;
  readonly synthesis_digest: string;
  readonly bundle_digest: string;
  readonly facts: readonly ProjectDiscoveryFact[];
  readonly capability_candidates: readonly ProjectDiscoveryCapabilityCandidate[];
  readonly gate_candidates: readonly ProjectDiscoveryGateCandidate[];
}

export type DiscoveryRecommendationOutcome =
  | { readonly status: "ok"; readonly recommendation: ProjectDiscoveryRecommendation }
  | { readonly status: "rejected"; readonly failure: GroundedSynthesisFailure };

export function discoveryRecommendationFromRecord(
  record: GroundedSynthesisRecord,
  bundle: ProjectContextBundleRecord,
): DiscoveryRecommendationOutcome {
  if (record.purpose !== "project_discovery" || record.output.purpose !== "project_discovery") {
    return {
      status: "rejected",
      failure: {
        code: "unknown_purpose",
        summary: "only project_discovery records can produce discovery recommendations",
        retryable: false,
      },
    };
  }
  if (record.bundle_digest !== bundle.record_digest) {
    return {
      status: "rejected",
      failure: {
        code: "bundle_stale",
        summary: "the record was synthesized against a different bundle",
        retryable: false,
      },
    };
  }
  const citationIssues = validateGroundedCitations(record.output, bundle);
  if (citationIssues.length > 0) {
    return {
      status: "rejected",
      failure: {
        code: citationIssues[0]!.code,
        summary: citationIssues[0]!.message,
        retryable: false,
      },
    };
  }
  return {
    status: "ok",
    recommendation: {
      kind: "project_discovery_recommendation",
      advisory: true,
      synthesis_digest: record.record_digest,
      bundle_digest: record.bundle_digest,
      facts: record.output.facts,
      capability_candidates: record.output.capability_candidates,
      gate_candidates: record.output.gate_candidates,
    },
  };
}
