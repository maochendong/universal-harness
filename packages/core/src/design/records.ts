import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import type {
  DesignGeneratorProvenance,
  DesignReviewDraft,
  DesignReviewRecord,
  DesignSetContent,
  DesignSetProposalRecord,
} from "../schema/index.js";
import { designSetContentDigest } from "./canonical.js";

/**
 * Design record factories (designset lifecycle design 7.4, plan T12). A
 * record that cannot validate never exists: every factory seals the envelope
 * and validates against the domain registry, throwing on any violation. Ids
 * derive deterministically from the semantic content so a resume re-creating
 * the same proposal or review lands on the same identity — generator
 * provenance and timestamps are evidence, never identity.
 */
export class DesignRecordError extends Error {
  readonly kind = "design_record_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "DesignRecordError";
  }
}

export function createDesignSetProposalRecord(input: {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly created_at: string;
  readonly generator: DesignGeneratorProvenance;
  readonly content: DesignSetContent;
}): DesignSetProposalRecord {
  const content_digest = designSetContentDigest(input.content);
  const record = sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "design_set_proposal",
    proposal_id: domainRecordId({
      domain_tag: "design_set_proposal",
      id_prefix: "design-set-proposal",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        workflow_operation_id: input.workflow_operation_id,
        content_digest,
      },
    }),
    workflow_operation_id: input.workflow_operation_id,
    iteration_id: input.iteration_id,
    created_at: input.created_at,
    generator: input.generator,
    content: input.content,
    content_digest,
  });
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-set-proposal", record);
  if (!validation.valid) {
    throw new DesignRecordError(
      `design set proposal failed validation: ${validation.errors[0]?.message ?? "unknown"}`,
    );
  }
  return record as DesignSetProposalRecord;
}

export function createDesignReviewRecord(input: {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly proposal_digest: string;
  readonly proposal_content_digest: string;
  readonly validation_digest: string;
  readonly review_bundle_digest: string;
  readonly reviewer_port: string;
  readonly conversation_id: string;
  readonly run_id: string;
  readonly output: DesignReviewDraft;
}): DesignReviewRecord {
  const record = sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "design_review",
    review_id: domainRecordId({
      domain_tag: "design_review",
      id_prefix: "design-review",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        proposal_digest: input.proposal_digest,
        review_bundle_digest: input.review_bundle_digest,
        output_digest: contentDigest(input.output),
      },
    }),
    workflow_operation_id: input.workflow_operation_id,
    iteration_id: input.iteration_id,
    proposal_digest: input.proposal_digest,
    proposal_content_digest: input.proposal_content_digest,
    validation_digest: input.validation_digest,
    review_bundle_digest: input.review_bundle_digest,
    reviewer_port: input.reviewer_port,
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    output: input.output,
  });
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-review", record);
  if (!validation.valid) {
    throw new DesignRecordError(
      `design review failed validation: ${validation.errors[0]?.message ?? "unknown"}`,
    );
  }
  return record as DesignReviewRecord;
}
