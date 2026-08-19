import { contentDigest } from "../identity/digest.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import type {
  CapabilityId,
  ProfileDecisionRecord,
  ProfileId,
  ProfileRecommendationRecord,
} from "../schema/profile.js";
import { profileDefinition, profileRank } from "./definitions.js";

/**
 * Profile decision rules (slim-profiles design 8.3, 11). A recommendation may
 * be overridden with a recorded reason, but a Policy floor (`minimum_profile`,
 * `required_capabilities`, `denied_capabilities`) can never be overridden by
 * any decision kind; overrides stay bound to their iteration, risk object and
 * scope digests and go stale the moment any of them drifts.
 */
export class ProfileDecisionError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ProfileDecisionError";
    this.kind = kind;
  }
}

/**
 * Project Policy constraints as far as profile selection is concerned. Policy
 * may only tighten the profile (raise the floor, require conditional
 * capabilities); it can never relax a profile-required capability or be
 * overridden (design 7.1, 11.4).
 */
export interface ProfilePolicyConstraints {
  readonly minimum_profile?: ProfileId;
  readonly required_capabilities?: readonly CapabilityId[];
  readonly denied_capabilities?: readonly CapabilityId[];
}

/** Digest of the accepted Policy a decision/record was made under. */
export function profilePolicyDigest(constraints: ProfilePolicyConstraints): string {
  return contentDigest({
    minimum_profile: constraints.minimum_profile ?? null,
    required_capabilities: [...(constraints.required_capabilities ?? [])].sort(),
    denied_capabilities: [...(constraints.denied_capabilities ?? [])].sort(),
  });
}

export const DEFAULT_PROFILE_POLICY_DIGEST = profilePolicyDigest({});

export interface ProfileDecisionInput {
  readonly decision_kind: ProfileDecisionRecord["decision_kind"];
  readonly project_id: string;
  readonly actor: string;
  readonly idempotency_key: string;
  readonly current_profile_id: ProfileId;
  readonly decided_profile_id: ProfileId;
  readonly policy_digest: string;
  readonly decided_at: string;
  readonly iteration_id?: string;
  readonly reason?: string;
  readonly recommendation?: ProfileRecommendationRecord;
  readonly requirement_digest?: string;
  readonly risk_digest?: string;
  readonly scope_digest?: string;
  readonly policy?: ProfilePolicyConstraints;
}

/**
 * The decision identity is derived from the idempotency key alone: re-issuing
 * the same decision (crash/retry) yields the same id, and the append-only
 * store turns the replay into a no-op instead of a duplicate record.
 */
export function profileDecisionId(projectId: string, idempotencyKey: string): string {
  return domainRecordId({
    domain_tag: "profile_decision",
    id_prefix: "profile-decision",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: { project_id: projectId, idempotency_key: idempotencyKey },
  });
}

function assertPolicyAllows(
  policy: ProfilePolicyConstraints | undefined,
  decided: ProfileId,
): void {
  if (policy === undefined) return;
  if (
    policy.minimum_profile !== undefined &&
    profileRank(decided) < profileRank(policy.minimum_profile)
  ) {
    throw new ProfileDecisionError(
      "policy_minimum_not_met",
      `policy requires at least ${policy.minimum_profile}; ${decided} cannot be decided`,
    );
  }
  const definition = profileDefinition(decided);
  for (const capability of policy.required_capabilities ?? []) {
    if (definition.capabilities[capability] === "disabled") {
      throw new ProfileDecisionError(
        "policy_required_not_overridable",
        `policy requires ${capability} but profile ${decided} disables it`,
      );
    }
  }
  for (const capability of policy.denied_capabilities ?? []) {
    if (definition.capabilities[capability] === "required") {
      throw new ProfileDecisionError(
        "policy_deny_not_overridable",
        `policy denies ${capability} but profile ${decided} requires it; no decision can override a policy deny`,
      );
    }
  }
}

export function createProfileDecisionRecord(input: ProfileDecisionInput): ProfileDecisionRecord {
  switch (input.decision_kind) {
    case "keep":
      if (input.decided_profile_id !== input.current_profile_id) {
        throw new ProfileDecisionError(
          "not_a_keep",
          "a keep decision must retain the current profile",
        );
      }
      break;
    case "temporary_upgrade":
      if (input.iteration_id === undefined) {
        throw new ProfileDecisionError(
          "missing_binding",
          "a temporary upgrade must bind the iteration it applies to",
        );
      }
      if (profileRank(input.decided_profile_id) <= profileRank(input.current_profile_id)) {
        throw new ProfileDecisionError(
          "not_an_upgrade",
          "a temporary upgrade must decide a strictly higher profile",
        );
      }
      if (
        input.requirement_digest === undefined ||
        input.risk_digest === undefined ||
        input.scope_digest === undefined
      ) {
        throw new ProfileDecisionError(
          "missing_binding",
          "a temporary upgrade must bind the requirement, risk and scope digests",
        );
      }
      break;
    case "project_profile_change":
      // The initial selection is recorded as a project_profile_change whose
      // current and decided profiles coincide (there is no prior baseline).
      break;
    case "override_recommendation": {
      if (input.reason === undefined || input.reason.trim().length === 0) {
        throw new ProfileDecisionError(
          "override_reason_required",
          "an override must record a non-empty reason",
        );
      }
      if (input.recommendation === undefined) {
        throw new ProfileDecisionError(
          "override_recommendation_required",
          "an override must bind the recommendation it overrides",
        );
      }
      if (
        input.iteration_id === undefined ||
        input.requirement_digest === undefined ||
        input.risk_digest === undefined ||
        input.scope_digest === undefined
      ) {
        throw new ProfileDecisionError(
          "missing_binding",
          "an override must bind the iteration, requirement, risk and scope digests",
        );
      }
      break;
    }
  }
  assertPolicyAllows(input.policy, input.decided_profile_id);

  const approval_digest = contentDigest({
    actor: input.actor,
    decision: "approve",
    decided_at: input.decided_at,
    decided_profile_id: input.decided_profile_id,
    idempotency_key: input.idempotency_key,
    project_id: input.project_id,
  });

  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "profile_decision" as const,
    profile_decision_id: profileDecisionId(input.project_id, input.idempotency_key),
    idempotency_key: input.idempotency_key,
    decision_kind: input.decision_kind,
    project_id: input.project_id,
    ...(input.iteration_id === undefined ? {} : { iteration_id: input.iteration_id }),
    actor: input.actor,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.recommendation === undefined
      ? {}
      : {
          recommendation_id: input.recommendation.profile_recommendation_id,
          recommendation_digest: input.recommendation.record_digest,
        }),
    current_profile_id: input.current_profile_id,
    decided_profile_id: input.decided_profile_id,
    ...(input.requirement_digest === undefined
      ? {}
      : { requirement_digest: input.requirement_digest }),
    ...(input.risk_digest === undefined ? {} : { risk_digest: input.risk_digest }),
    ...(input.scope_digest === undefined ? {} : { scope_digest: input.scope_digest }),
    policy_digest: input.policy_digest,
    approval_digest,
    decided_at: input.decided_at,
  });
}

export interface ProfileDecisionBindingSnapshot {
  readonly policy_digest: string;
  readonly iteration_id?: string;
  readonly requirement_digest?: string;
  readonly risk_digest?: string;
  readonly scope_digest?: string;
}

/**
 * Whether a decision's bindings still match reality (design 11.3). Overrides
 * and temporary upgrades are pinned to their iteration and to every bound
 * digest; any drift — scope, risk, requirement or policy — invalidates them.
 */
export function isProfileDecisionBindingCurrent(
  decision: ProfileDecisionRecord,
  current: ProfileDecisionBindingSnapshot,
): boolean {
  if (decision.policy_digest !== current.policy_digest) return false;
  const iterationScoped =
    decision.decision_kind === "temporary_upgrade" ||
    decision.decision_kind === "override_recommendation";
  if (iterationScoped && decision.iteration_id !== current.iteration_id) return false;
  for (const key of ["requirement_digest", "risk_digest", "scope_digest"] as const) {
    const bound = decision[key];
    if (bound === undefined) continue;
    if (current[key] === undefined || current[key] !== bound) return false;
  }
  return true;
}
