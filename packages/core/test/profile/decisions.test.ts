import { describe, expect, it } from "vitest";

import {
  ProfileDecisionError,
  createProfileDecisionRecord,
  isProfileDecisionBindingCurrent,
} from "../../src/profile/decisions.js";
import { createProfileRecommendationRecord } from "../../src/profile/recommendation.js";
import type { ProfileDecisionInput } from "../../src/profile/decisions.js";
import { verifyRecordEnvelope } from "../../src/schema/envelope.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const TIMESTAMP = "2026-08-19T00:00:00.000Z";

function baseInput(overrides: Partial<ProfileDecisionInput> = {}): ProfileDecisionInput {
  return {
    decision_kind: "keep",
    project_id: "project_demo-app",
    iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
    actor: "human:reviewer",
    idempotency_key: "decision-1",
    current_profile_id: "lite",
    decided_profile_id: "lite",
    requirement_digest: DIGEST_A,
    risk_digest: DIGEST_B,
    scope_digest: DIGEST_C,
    policy_digest: DIGEST_D,
    decided_at: TIMESTAMP,
    ...overrides,
  };
}

function liteToStandardRecommendation() {
  const recommendation = createProfileRecommendationRecord({
    project_id: "project_demo-app",
    iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
    current_profile_id: "lite",
    triggered: ["public_api_change"],
    risk_object_digest: DIGEST_B,
    requirement_digest: DIGEST_A,
    scope_digest: DIGEST_C,
    policy_digest: DIGEST_D,
    rationale: "公共 API 变更，建议至少 Standard。",
  });
  if (recommendation === undefined) throw new Error("expected a recommendation");
  return recommendation;
}

describe("profile decisions", () => {
  it("records a keep decision bound to actor, digests and approval", () => {
    const decision = createProfileDecisionRecord(baseInput());
    expect(decision.record_kind).toBe("profile_decision");
    expect(decision.profile_decision_id).toMatch(/^profile-decision_[A-Za-z0-9_-]+$/);
    expect(decision.approval_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyRecordEnvelope(decision as unknown as Record<string, unknown>)).toBe(true);
  });

  it("derives the decision identity from the idempotency key only", () => {
    const first = createProfileDecisionRecord(baseInput());
    const second = createProfileDecisionRecord(
      baseInput({ decided_at: "2026-08-20T00:00:00.000Z" }),
    );
    expect(second.profile_decision_id).toBe(first.profile_decision_id);
    const other = createProfileDecisionRecord(baseInput({ idempotency_key: "decision-2" }));
    expect(other.profile_decision_id).not.toBe(first.profile_decision_id);
  });

  it("requires a non-empty reason and a bound recommendation for overrides", () => {
    expect(() =>
      createProfileDecisionRecord(
        baseInput({ decision_kind: "override_recommendation", decided_profile_id: "lite" }),
      ),
    ).toThrow(ProfileDecisionError);
    try {
      createProfileDecisionRecord(
        baseInput({
          decision_kind: "override_recommendation",
          reason: "  ",
          recommendation: liteToStandardRecommendation(),
        }),
      );
      expect.unreachable("blank override reason must throw");
    } catch (error) {
      expect((error as ProfileDecisionError).kind).toBe("override_reason_required");
    }
    try {
      createProfileDecisionRecord(
        baseInput({ decision_kind: "override_recommendation", reason: "接受风险，保持 Lite。" }),
      );
      expect.unreachable("override without recommendation must throw");
    } catch (error) {
      expect((error as ProfileDecisionError).kind).toBe("override_recommendation_required");
    }

    const override = createProfileDecisionRecord(
      baseInput({
        decision_kind: "override_recommendation",
        reason: "接受风险，保持 Lite。",
        recommendation: liteToStandardRecommendation(),
      }),
    );
    expect(override.recommendation_id).toBe(
      liteToStandardRecommendation().profile_recommendation_id,
    );
  });

  it("enforces the binding digests on iteration-scoped decisions", () => {
    const missingRisk = baseInput({
      decision_kind: "temporary_upgrade",
      decided_profile_id: "standard",
    });
    const withoutRiskDigest: ProfileDecisionInput = { ...missingRisk };
    delete (withoutRiskDigest as { risk_digest?: string }).risk_digest;
    expect(() => createProfileDecisionRecord(withoutRiskDigest)).toThrow(ProfileDecisionError);
    expect(() =>
      createProfileDecisionRecord(
        baseInput({ decision_kind: "temporary_upgrade", decided_profile_id: "lite" }),
      ),
    ).toThrow(ProfileDecisionError);
    const missingIteration = baseInput({
      decision_kind: "temporary_upgrade",
      decided_profile_id: "standard",
    });
    const withoutIterationId: ProfileDecisionInput = { ...missingIteration };
    delete (withoutIterationId as { iteration_id?: string }).iteration_id;
    expect(() => createProfileDecisionRecord(withoutIterationId)).toThrow(ProfileDecisionError);
  });

  it("lets policy tighten but never loosen: required and deny survive every decision", () => {
    const policy = { minimum_profile: "standard" as const };
    try {
      createProfileDecisionRecord(
        baseInput({
          decision_kind: "override_recommendation",
          reason: "尝试覆盖 Policy 最低档位。",
          recommendation: liteToStandardRecommendation(),
          decided_profile_id: "lite",
          policy,
        }),
      );
      expect.unreachable("override below the policy minimum must throw");
    } catch (error) {
      expect((error as ProfileDecisionError).kind).toBe("policy_minimum_not_met");
    }

    const denied = { denied_capabilities: ["impact_analysis" as const] };
    try {
      createProfileDecisionRecord(
        baseInput({
          decision_kind: "temporary_upgrade",
          decided_profile_id: "standard",
          policy: denied,
        }),
      );
      expect.unreachable("a denied profile-required capability must throw");
    } catch (error) {
      expect((error as ProfileDecisionError).kind).toBe("policy_deny_not_overridable");
    }

    const tightened = createProfileDecisionRecord(
      baseInput({
        decision_kind: "temporary_upgrade",
        decided_profile_id: "standard",
        policy: {
          minimum_profile: "standard" as const,
          required_capabilities: ["strict_tdd" as const],
        },
      }),
    );
    expect(tightened.decided_profile_id).toBe("standard");
  });

  it("invalidates an override when any bound scope drifts", () => {
    const override = createProfileDecisionRecord(
      baseInput({
        decision_kind: "override_recommendation",
        reason: "接受风险，保持 Lite。",
        recommendation: liteToStandardRecommendation(),
      }),
    );
    const current = {
      iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
      requirement_digest: DIGEST_A,
      risk_digest: DIGEST_B,
      scope_digest: DIGEST_C,
      policy_digest: DIGEST_D,
    };
    expect(isProfileDecisionBindingCurrent(override, current)).toBe(true);
    expect(
      isProfileDecisionBindingCurrent(override, { ...current, scope_digest: "e".repeat(64) }),
    ).toBe(false);
    expect(
      isProfileDecisionBindingCurrent(override, { ...current, risk_digest: "e".repeat(64) }),
    ).toBe(false);
    expect(
      isProfileDecisionBindingCurrent(override, { ...current, policy_digest: "e".repeat(64) }),
    ).toBe(false);
    expect(
      isProfileDecisionBindingCurrent(override, {
        ...current,
        iteration_id: "iteration_01K1ABCDEFGHIJKLMNP",
      }),
    ).toBe(false);
  });
});
