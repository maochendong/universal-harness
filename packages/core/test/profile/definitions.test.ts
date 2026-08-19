import { describe, expect, it } from "vitest";

import {
  PROFILE_DEFINITIONS,
  ProfileRegistryError,
  isProfileId,
  profileDefinition,
  profileRank,
} from "../../src/profile/definitions.js";
import { PROFILE_IDS } from "../../src/schema/profile.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";

describe("profile registry", () => {
  it("exposes exactly the three protocol 1.1 profiles in rank order", () => {
    expect(PROFILE_IDS).toEqual(["lite", "standard", "governed"]);
    expect(PROFILE_DEFINITIONS.map((definition) => definition.profile_id)).toEqual([
      "lite",
      "standard",
      "governed",
    ]);
    expect(profileRank("lite")).toBeLessThan(profileRank("standard"));
    expect(profileRank("standard")).toBeLessThan(profileRank("governed"));
  });

  it("pins the protocol version and the capability modes of each tier", () => {
    const lite = profileDefinition("lite");
    expect(lite.protocol_version).toBe("1.1.0");
    expect(lite.capabilities).toEqual({
      impact_analysis: "conditional",
      design_governance: "conditional",
      independent_evaluation: "conditional",
      strict_tdd: "conditional",
      advanced_audit: "conditional",
    });

    const standard = profileDefinition("standard");
    expect(standard.capabilities).toEqual({
      impact_analysis: "required",
      design_governance: "required",
      independent_evaluation: "required",
      strict_tdd: "conditional",
      advanced_audit: "conditional",
    });

    const governed = profileDefinition("governed");
    expect(governed.capabilities).toEqual({
      impact_analysis: "required",
      design_governance: "required",
      independent_evaluation: "required",
      strict_tdd: "required",
      advanced_audit: "required",
    });
  });

  it("computes a stable definition digest that reacts to any semantic change", () => {
    const definition = profileDefinition("lite");
    expect(definition.definition_digest).toMatch(/^[a-f0-9]{64}$/);
    const digests = PROFILE_DEFINITIONS.map((entry) => entry.definition_digest);
    expect(new Set(digests).size).toBe(3);
    for (const entry of PROFILE_DEFINITIONS) {
      expect(
        PROTOCOL_1_1_SCHEMA_REGISTRY.validate("profile-definition", entry),
        entry.profile_id,
      ).toEqual({ valid: true, errors: [] });
    }
  });

  it("fails closed on unknown profile ids instead of falling back", () => {
    expect(isProfileId("lite")).toBe(true);
    expect(isProfileId("Standard")).toBe(false);
    expect(isProfileId("")).toBe(false);
    expect(() => profileDefinition("turbo")).toThrow(ProfileRegistryError);
    expect(() => profileDefinition("1.0-default")).toThrow(ProfileRegistryError);
  });
});
