import {
  contentDigest,
  validateSchema,
  type FeedbackRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  proposedByOf,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
} from "@universal-harness-internal/runtime";

import { FeedbackError, resealFeedbackRecord } from "./finding.js";
import { readImprovementContent } from "./improvement.js";
import { OWNING_NODE_TYPES } from "./router.js";

/**
 * ImprovementCandidate promotion (design 9.1 and principle 8, plan Task 21).
 * A candidate stays `proposed` until an ApprovalRequest bound to its exact
 * digest is resolved with an `approve` decision by someone other than the
 * proposer -- an agent never promotes its own improvement. Promotion then
 * creates a normal ledger revision of the target node: revision + 1,
 * accepted, freshly digested, owned by the candidate's target layer. A
 * rejected, deferred, misbound or self-approved decision changes nothing.
 */
export interface PromotionInput {
  /** The proposed ImprovementCandidate being promoted. */
  readonly candidate: FeedbackRecord;
  /** ApprovalRequest bound to the candidate id and digest. */
  readonly request: ApprovalRequestRecord;
  /** Decision resolving that request. */
  readonly decision: ApprovalDecisionRecord;
  /** Current accepted revision of the target node. */
  readonly target: NodeRecord;
  /** Actor applying the promotion (the Workflow Engine). */
  readonly actor: string;
  readonly timestamp: string;
}

export interface PromotionOutcome {
  /** The promoted candidate, resealed as accepted. */
  readonly candidate: FeedbackRecord;
  /** The new accepted ledger revision of the target node. */
  readonly revision: NodeRecord;
}

/**
 * Promote a candidate under an approving decision. Every binding is checked
 * against the exact candidate digest the approval saw; any drift, a missing
 * approval, a non-approve decision or a self-approval is rejected with a
 * typed error and the candidate stays proposed.
 */
export function promoteImprovementCandidate(input: PromotionInput): PromotionOutcome {
  const content = readImprovementContent(input.candidate);
  if (input.candidate.status !== "proposed") {
    throw new FeedbackError(
      "invalid_feedback_transition",
      `cannot promote improvement candidate ${input.candidate.id} in status ${input.candidate.status}`,
    );
  }
  if (
    input.request.object_id !== input.candidate.id ||
    input.request.object_digest !== input.candidate.digest ||
    input.decision.request_id !== input.request.request_id ||
    input.decision.object_digest !== input.candidate.digest
  ) {
    throw new FeedbackError(
      "promotion_binding_mismatch",
      `approval for improvement candidate ${input.candidate.id} does not bind its current digest`,
    );
  }
  if (input.decision.actor === proposedByOf(input.request)) {
    throw new FeedbackError(
      "self_promotion",
      `actor ${input.decision.actor} must not promote its own improvement candidate ${input.candidate.id}`,
    );
  }
  if (input.decision.decision !== "approve") {
    throw new FeedbackError(
      "unapproved_promotion",
      `improvement candidate ${input.candidate.id} stays proposed: decision was ${input.decision.decision}`,
    );
  }
  const owningTypes = OWNING_NODE_TYPES[content.target_layer];
  if (!owningTypes.includes(input.target.type)) {
    throw new FeedbackError(
      "promotion_binding_mismatch",
      `target ${input.target.id} of type ${input.target.type} is not owned by layer ${content.target_layer}`,
    );
  }
  const revisionContent: Record<string, unknown> = {
    ...input.target,
    revision: input.target.revision + 1,
    status: "accepted",
    provenance: {
      iteration_id: input.candidate.iteration_id,
      actor: input.actor,
      timestamp: input.timestamp,
    },
  };
  delete revisionContent.digest;
  const revision = { ...revisionContent, digest: contentDigest(revisionContent) };
  const validation = validateSchema("node", revision);
  if (!validation.valid) {
    const detail = validation.errors
      .map((issue) => `${issue.instancePath}: ${issue.message}`)
      .join("; ");
    throw new FeedbackError(
      "invalid_feedback_record",
      `invalid promoted target revision: ${detail}`,
    );
  }
  return {
    candidate: resealFeedbackRecord(input.candidate, "accepted"),
    revision: revision as unknown as NodeRecord,
  };
}
