import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import type {
  CaptureModelProviderBindingRecord,
  ModelProviderBinding,
  ProfileId,
  ProjectProfileRecord,
} from "../schema/profile.js";
import { profileDefinition } from "./definitions.js";
import { bindingScopeKey, isCaptureScopeBinding } from "./model-slots.js";

/**
 * Constructors for the Protocol 1.1 profile records (slim-profiles design 8
 * and model advisory design 11.1). Identity is derived deterministically with
 * `domainRecordId`, collections are canonically ordered before sealing, and
 * every record is sealed with its envelope digest on creation.
 */
export class ProfileRecordError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ProfileRecordError";
    this.kind = kind;
  }
}

export class ProfileBindingError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ProfileBindingError";
    this.kind = kind;
  }
}

export interface CreateProjectProfileRecordInput {
  readonly project_id: string;
  readonly revision: number;
  readonly profile_id: ProfileId;
  readonly policy_digest: string;
  readonly actor: string;
  readonly effective_from: string;
  readonly supersedes_digest?: string;
}

/**
 * The selection confirmation is itself an auditable approval: the request id
 * is derived from the project/revision/profile identity and the approval
 * digest seals the actor's decision against the definition and policy.
 */
function profileSelectionApproval(input: {
  readonly project_id: string;
  readonly revision: number;
  readonly profile_id: ProfileId;
  readonly policy_digest: string;
  readonly actor: string;
}): { approval_request_id: string; approval_digest: string } {
  const approval_request_id = domainRecordId({
    domain_tag: "profile_approval",
    id_prefix: "profile-approval",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: {
      project_id: input.project_id,
      revision: input.revision,
      profile_id: input.profile_id,
    },
  });
  const approval_digest = contentDigest({
    approval_request_id,
    decision: "approve",
    actor: input.actor,
    object_digest: profileDefinition(input.profile_id).definition_digest,
    policy_digest: input.policy_digest,
  });
  return { approval_request_id, approval_digest };
}

export function createProjectProfileRecord(
  input: CreateProjectProfileRecordInput,
): ProjectProfileRecord {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new ProfileRecordError("invalid_revision", "profile revision must be a positive integer");
  }
  const definition = profileDefinition(input.profile_id);
  const approval = profileSelectionApproval({
    project_id: input.project_id,
    revision: input.revision,
    profile_id: input.profile_id,
    policy_digest: input.policy_digest,
    actor: input.actor,
  });
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "project_profile" as const,
    project_profile_id: domainRecordId({
      domain_tag: "project_profile",
      id_prefix: "project-profile",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: { project_id: input.project_id, revision: input.revision },
    }),
    project_id: input.project_id,
    revision: input.revision,
    profile_id: input.profile_id,
    profile_definition_digest: definition.definition_digest,
    policy_digest: input.policy_digest,
    approval_request_id: approval.approval_request_id,
    approval_digest: approval.approval_digest,
    effective_from: input.effective_from,
    ...(input.supersedes_digest === undefined
      ? {}
      : { supersedes_digest: input.supersedes_digest }),
  });
}

export function createCaptureModelProviderBindingRecord(input: {
  readonly project_id: string;
  readonly profile_decision_id: string;
  readonly profile_decision_digest: string;
  readonly policy_digest: string;
  readonly config_digest: string;
  readonly baseline_digest: string;
  readonly bindings: readonly ModelProviderBinding[];
}): CaptureModelProviderBindingRecord {
  const bindings = [...input.bindings].sort((left, right) =>
    bindingScopeKey(left) < bindingScopeKey(right) ? -1 : 1,
  );
  const keys = bindings.map((binding) => bindingScopeKey(binding));
  if (new Set(keys).size !== keys.length) {
    throw new ProfileBindingError(
      "duplicate_binding",
      "each slot/purpose may appear at most once in a binding record",
    );
  }
  for (const binding of bindings) {
    if (!isCaptureScopeBinding(binding)) {
      throw new ProfileBindingError(
        "non_capture_scope_binding",
        `slot/purpose ${bindingScopeKey(binding)} is not part of the capture scope`,
      );
    }
  }
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "model_provider_binding" as const,
    model_provider_binding_id: domainRecordId({
      domain_tag: "model_provider_binding",
      id_prefix: "model-provider-binding",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        scope: "capture",
        project_id: input.project_id,
        profile_decision_digest: input.profile_decision_digest,
        baseline_digest: input.baseline_digest,
      },
    }),
    scope: "capture" as const,
    project_id: input.project_id,
    profile_decision_id: input.profile_decision_id,
    profile_decision_digest: input.profile_decision_digest,
    policy_digest: input.policy_digest,
    config_digest: input.config_digest,
    baseline_digest: input.baseline_digest,
    bindings,
  });
}
