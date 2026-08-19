import { canonicalStringSet } from "../identity/canonical-set.js";
import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import {
  PROFILE_RECOMMENDATION_TRIGGER_IDS,
  type ProfileId,
  type ProfileRecommendationRecord,
  type ProfileRecommendationTriggerId,
} from "../schema/profile.js";
import { profileRank } from "./definitions.js";

/**
 * Risk-driven profile recommendations (slim-profiles design 11.1/11.2). The
 * triggers are a versioned policy input — code never hard-codes a UI copy and
 * unknown trigger ids fail closed. A recommendation is a fact record only; it
 * never widens authority by itself.
 */
export interface ProfileRecommendationTrigger {
  readonly trigger_id: ProfileRecommendationTriggerId;
  readonly minimum_profile: "standard" | "governed";
  readonly description: string;
}

export const PROFILE_RECOMMENDATION_TRIGGERS: readonly ProfileRecommendationTrigger[] = [
  {
    trigger_id: "cross_component_change",
    minimum_profile: "standard",
    description: "变更跨多个组件或仓库",
  },
  {
    trigger_id: "public_api_change",
    minimum_profile: "standard",
    description: "触及公共 API、数据 Schema、迁移或兼容性",
  },
  {
    trigger_id: "data_schema_or_migration_change",
    minimum_profile: "standard",
    description: "涉及数据 Schema 或迁移",
  },
  {
    trigger_id: "security_or_supply_chain_surface",
    minimum_profile: "standard",
    description: "涉及安全、权限、secret 或依赖供应链",
  },
  {
    trigger_id: "medium_high_impact_uncertainty",
    minimum_profile: "standard",
    description: "影响不确定性为 medium/high",
  },
  {
    trigger_id: "independent_evaluation_or_design_contract_required",
    minimum_profile: "standard",
    description: "需要独立 Evaluation 或 Design contract",
  },
  {
    trigger_id: "insufficient_gate_foundation",
    minimum_profile: "standard",
    description: "项目 Gate/测试基础不足以支撑直接执行",
  },
  {
    trigger_id: "critical_risk",
    minimum_profile: "governed",
    description: "critical 风险",
  },
  {
    trigger_id: "regulatory_or_audit_constraint",
    minimum_profile: "governed",
    description: "受法规或审计要求约束",
  },
  {
    trigger_id: "irreversible_external_effect",
    minimum_profile: "governed",
    description: "存在不可逆外部副作用",
  },
  {
    trigger_id: "production_or_sensitive_data_access",
    minimum_profile: "governed",
    description: "触及生产权限、资金、身份或敏感数据",
  },
  {
    trigger_id: "policy_mandated_governance",
    minimum_profile: "governed",
    description: "项目 Policy 明确要求强 TDD 或职责分离",
  },
];

export class ProfileRecommendationError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ProfileRecommendationError";
    this.kind = kind;
  }
}

const TRIGGER_BY_ID = new Map(
  PROFILE_RECOMMENDATION_TRIGGERS.map((trigger) => [trigger.trigger_id, trigger]),
);

export interface ProfileUpgradeRecommendation {
  readonly recommended_profile_id: ProfileId;
  /** Canonical (deduplicated, sorted) trigger ids that forced the recommendation. */
  readonly triggers: readonly string[];
}

/**
 * Compute the minimum profile covering every triggered risk signal. Returns
 * `undefined` when the current profile already covers them — a recommendation
 * only ever points upwards.
 */
export function recommendProfileUpgrade(input: {
  readonly current_profile_id: ProfileId;
  readonly triggered: readonly string[];
}): ProfileUpgradeRecommendation | undefined {
  const triggers = canonicalStringSet(input.triggered);
  let recommended: ProfileId = "lite";
  for (const triggerId of triggers) {
    if (!(PROFILE_RECOMMENDATION_TRIGGER_IDS as readonly string[]).includes(triggerId)) {
      throw new ProfileRecommendationError(
        "unknown_trigger",
        `unregistered recommendation trigger: ${triggerId}`,
      );
    }
    const trigger = TRIGGER_BY_ID.get(triggerId as ProfileRecommendationTriggerId);
    if (trigger !== undefined && profileRank(trigger.minimum_profile) > profileRank(recommended)) {
      recommended = trigger.minimum_profile;
    }
  }
  if (triggers.length === 0 || profileRank(recommended) <= profileRank(input.current_profile_id)) {
    return undefined;
  }
  return { recommended_profile_id: recommended, triggers };
}

export interface CreateProfileRecommendationRecordInput {
  readonly project_id: string;
  readonly iteration_id: string;
  readonly current_profile_id: ProfileId;
  readonly triggered: readonly string[];
  readonly risk_object_digest: string;
  readonly requirement_digest: string;
  readonly scope_digest: string;
  readonly policy_digest: string;
  /** 中文理由，说明触发器与建议档位的关系。 */
  readonly rationale: string;
  readonly scope_reduction_hint?: string;
}

/**
 * Materialize the recommendation fact (design 8.2), or `undefined` when the
 * current profile already covers the triggered risk. Trigger ordering is
 * canonicalized so any input permutation seals to the same record.
 */
export function createProfileRecommendationRecord(
  input: CreateProfileRecommendationRecordInput,
): ProfileRecommendationRecord | undefined {
  const recommendation = recommendProfileUpgrade({
    current_profile_id: input.current_profile_id,
    triggered: input.triggered,
  });
  if (recommendation === undefined) return undefined;
  return sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "profile_recommendation" as const,
    profile_recommendation_id: domainRecordId({
      domain_tag: "profile_recommendation",
      id_prefix: "profile-recommendation",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        project_id: input.project_id,
        iteration_id: input.iteration_id,
        current_profile_id: input.current_profile_id,
        recommended_profile_id: recommendation.recommended_profile_id,
        triggers: recommendation.triggers,
        risk_object_digest: input.risk_object_digest,
        requirement_digest: input.requirement_digest,
        scope_digest: input.scope_digest,
        policy_digest: input.policy_digest,
      },
    }),
    project_id: input.project_id,
    iteration_id: input.iteration_id,
    current_profile_id: input.current_profile_id,
    recommended_profile_id: recommendation.recommended_profile_id,
    // recommendProfileUpgrade has already validated membership in the trigger
    // registry, so narrowing to the schema's union is sound here.
    triggers: [...recommendation.triggers] as ProfileRecommendationRecord["triggers"],
    risk_object_digest: input.risk_object_digest,
    requirement_digest: input.requirement_digest,
    scope_digest: input.scope_digest,
    policy_digest: input.policy_digest,
    rationale: input.rationale,
    ...(input.scope_reduction_hint === undefined
      ? {}
      : { scope_reduction_hint: input.scope_reduction_hint }),
  });
}
