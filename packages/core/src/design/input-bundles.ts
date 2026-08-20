import { contentDigest } from "../identity/digest.js";
import type { ProjectContextSource } from "../schema/context.js";
import type { DesignSetContent } from "../schema/design-set.js";
import { canonicalizeDesignSetContent } from "./canonical.js";
import type { DesignReviewRubric } from "./ports.js";

/**
 * The design input compilers (designset lifecycle design 6.1/6.4, plan
 * T12). Both bundles are read-only, digest-bound and budget-limited views
 * over committed facts. The review bundle is compiled independently: it
 * never reuses the proposal bundle's identity, locators or digest, so
 * proposal and review contexts can never silently share a channel.
 */
export interface DesignBundle {
  readonly sources: readonly ProjectContextSource[];
  readonly bundle_digest: string;
}

export interface DesignProposalFacts {
  readonly requirement_baseline_digest: string;
  readonly impact_set_id: string;
  readonly impact_set_digest: string;
  readonly policy_digest: string;
  readonly repository_baseline: string;
  readonly must_change_requirement_ids: readonly string[];
  readonly requirement_impact_risks: Readonly<Record<string, "low" | "medium" | "high">>;
  readonly criterion_test_pairs: readonly {
    readonly requirement_id: string;
    readonly acceptance_criterion_id: string;
    readonly test_node_id: string;
  }[];
  /** Controlled, already-redacted graph/document neighborhood. */
  readonly neighborhood: readonly ProjectContextSource[];
}

export interface DesignReviewFacts {
  readonly proposal_content: DesignSetContent;
  readonly validation_digest: string;
  readonly policy_digest: string;
  readonly rubric: DesignReviewRubric;
}

function source(
  locator: string,
  sourceKind: ProjectContextSource["source_kind"],
  sourceDigest: string,
  selectionReason: string,
): ProjectContextSource {
  return {
    locator,
    source_kind: sourceKind,
    source_digest: sourceDigest,
    selection_reason: selectionReason,
    classification: "internal_project",
    summary: "",
    truncated: false,
  };
}

function byLocator(left: ProjectContextSource, right: ProjectContextSource): number {
  return left.locator < right.locator ? -1 : left.locator > right.locator ? 1 : 0;
}

function seal(purpose: string, sources: readonly ProjectContextSource[]): DesignBundle {
  const sorted = [...sources].sort(byLocator);
  return {
    sources: sorted,
    bundle_digest: contentDigest({
      purpose,
      sources: sorted.map((entry) => ({
        locator: entry.locator,
        source_digest: entry.source_digest,
      })),
    }),
  };
}

export function compileDesignProposalBundle(facts: DesignProposalFacts): DesignBundle {
  return seal("design_proposal", [
    source(
      `design://requirement-baseline/${facts.requirement_baseline_digest}`,
      "graph",
      facts.requirement_baseline_digest,
      "the accepted requirement baseline the design must cover",
    ),
    source(
      `design://impact-set/${facts.impact_set_id}`,
      "graph",
      facts.impact_set_digest,
      "the frozen impact set the design derives from",
    ),
    source(
      `design://policy/${facts.policy_digest}`,
      "policy",
      facts.policy_digest,
      "the accepted policy governing this design",
    ),
    source(
      `design://repository-baseline/${facts.repository_baseline}`,
      "manifest",
      contentDigest({ repository_baseline: facts.repository_baseline }),
      "the repository baseline the design targets",
    ),
    ...facts.neighborhood,
  ]);
}

export function compileDesignReviewBundle(facts: DesignReviewFacts): DesignBundle {
  const proposalDigest = contentDigest(canonicalizeDesignSetContent(facts.proposal_content));
  return seal("design_review", [
    source(
      `review://design-proposal/${proposalDigest}`,
      "graph",
      proposalDigest,
      "the deterministically validated design proposal under review",
    ),
    source(
      `review://validation/${facts.validation_digest}`,
      "gate",
      facts.validation_digest,
      "the deterministic validation outcome of the proposal",
    ),
    source(
      `review://policy/${facts.policy_digest}`,
      "policy",
      facts.policy_digest,
      "the accepted policy the review enforces",
    ),
    source(
      `review://rubric/${facts.rubric.rubric_id}`,
      "adr",
      contentDigest(facts.rubric),
      "the review rubric",
    ),
  ]);
}
