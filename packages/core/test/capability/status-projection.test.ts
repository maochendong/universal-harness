import { describe, expect, it } from "vitest";

import {
  GENERIC_CAPABILITY_STATUSES,
  StatusProjectionError,
  createCapabilityStatusProjector,
  type DomainStatusMapping,
} from "../../src/capability/status-projection.js";

/**
 * The TDD domain mapping is owned by the strict_tdd module (delivered with the
 * TDD state machine in Task 16); these tests exercise the projection contract
 * with the protocol-fixed mapping from slim-profiles design 7.5.
 */
const TDD_MAPPING: DomainStatusMapping = {
  capability_id: "strict_tdd",
  mappings: {
    tdd_proven: "proven",
    framework_proven: "proven",
    controlled_not_applicable: "controlled_not_applicable",
    not_enabled_by_profile: "not_enabled_by_profile",
    historical_without_tdd_proof: "historical_without_proof",
    tdd_incomplete_or_invalid: "invalid_or_incomplete",
  },
};

describe("capability status projection", () => {
  it("exposes exactly the five slim generic statuses", () => {
    expect([...GENERIC_CAPABILITY_STATUSES].sort()).toEqual([
      "controlled_not_applicable",
      "historical_without_proof",
      "invalid_or_incomplete",
      "not_enabled_by_profile",
      "proven",
    ]);
  });

  it("maps registered domain statuses and keeps the domain status alongside", () => {
    const projector = createCapabilityStatusProjector([TDD_MAPPING]);
    const projection = projector.project("strict_tdd", "framework_proven", {
      reason: "测试基础设施已证明，不表示生产需求完成 TDD。",
      binding_ids: ["binding_01K1ABCDEFGHIJKLMNO"],
    });
    expect(projection).toEqual({
      capability_id: "strict_tdd",
      generic_status: "proven",
      domain_status: "framework_proven",
      reason: "测试基础设施已证明，不表示生产需求完成 TDD。",
      binding_ids: ["binding_01K1ABCDEFGHIJKLMNO"],
    });
    expect(projector.project("strict_tdd", "tdd_incomplete_or_invalid").generic_status).toBe(
      "invalid_or_incomplete",
    );
    expect(projector.project("strict_tdd", "historical_without_tdd_proof").generic_status).toBe(
      "historical_without_proof",
    );
  });

  it("fails closed on domain statuses the owning module never registered", () => {
    const projector = createCapabilityStatusProjector([TDD_MAPPING]);
    expect(() => projector.project("strict_tdd", "looks_good_to_me")).toThrow(
      StatusProjectionError,
    );
    try {
      projector.project("strict_tdd", "passed");
      expect.unreachable("unknown domain statuses must throw");
    } catch (error) {
      expect((error as StatusProjectionError).kind).toBe("unknown_domain_status");
    }
  });

  it("fails closed on capabilities without a registered mapping", () => {
    const projector = createCapabilityStatusProjector([TDD_MAPPING]);
    try {
      projector.project("impact_analysis", "tdd_proven");
      expect.unreachable("unregistered capabilities must throw");
    } catch (error) {
      expect((error as StatusProjectionError).kind).toBe("unregistered_capability");
    }
  });

  it("fails closed at registration on generic statuses outside the slim five", () => {
    expect(() =>
      createCapabilityStatusProjector([
        {
          capability_id: "impact_analysis",
          mappings: { passed: "passed" } as never,
        },
      ]),
    ).toThrow(StatusProjectionError);
    try {
      createCapabilityStatusProjector([
        {
          capability_id: "impact_analysis",
          mappings: { complete: "complete" } as never,
        },
      ]);
      expect.unreachable("unknown generic statuses must throw");
    } catch (error) {
      expect((error as StatusProjectionError).kind).toBe("unknown_generic_status");
    }
  });

  it("rejects duplicate or unknown capability registrations", () => {
    expect(() => createCapabilityStatusProjector([TDD_MAPPING, TDD_MAPPING])).toThrow(
      StatusProjectionError,
    );
    expect(() =>
      createCapabilityStatusProjector([{ capability_id: "quantum_review", mappings: {} } as never]),
    ).toThrow(StatusProjectionError);
  });

  it("projects inactive capabilities as not_enabled_by_profile without any mapping", () => {
    const projector = createCapabilityStatusProjector([]);
    expect(projector.inactive("design_governance")).toEqual({
      capability_id: "design_governance",
      generic_status: "not_enabled_by_profile",
      domain_status: "not_enabled_by_profile",
      binding_ids: [],
    });
  });
});
