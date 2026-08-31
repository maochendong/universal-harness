import { describe, expect, it } from "vitest";

import {
  PROFILE_DEFINITIONS,
  PROFILE_DEFINITIONS_1_3,
  ProfileRegistryError,
  profileDefinition,
  profileDefinitionByDigest,
  profileDefinitionForProtocol,
  profileDefinitionVersionForProtocol,
} from "../../src/profile/definitions.js";
import {
  CAPABILITY_IDS,
  CAPABILITY_IDS_1_1,
  CAPABILITY_IDS_1_3,
  ProfileDefinitionSchema,
  ProfileDefinitionV11Schema,
  ProfileDefinitionV13Schema,
} from "../../src/schema/profile.js";
import { compileSchemaValidator } from "../../src/schema/validator.js";

/** The legacy lite definition digest pinned by test/golden/profile/project-profile.json. */
const LEGACY_LITE_DIGEST = "5c921bc9535d369ea8c2594800e9a1e2a27e09fadb0c1c808128daeda57026d1";

describe("versioned capability ids", () => {
  it("keeps the protocol 1.1 capability list explicit and unchanged", () => {
    expect(CAPABILITY_IDS_1_1).toEqual([
      "impact_analysis",
      "design_governance",
      "independent_evaluation",
      "strict_tdd",
      "advanced_audit",
    ]);
    // The legacy CAPABILITY_IDS alias must keep resolving to the 1.1 list.
    expect(CAPABILITY_IDS).toEqual(CAPABILITY_IDS_1_1);
  });

  it("extends protocol 1.3 with parallel_task_execution only", () => {
    expect(CAPABILITY_IDS_1_3).toEqual([...CAPABILITY_IDS_1_1, "parallel_task_execution"]);
  });
});

describe("profileDefinitionForProtocol", () => {
  it("resolves the 1.1 definitions without parallel_task_execution", () => {
    for (const profileId of ["lite", "standard", "governed"] as const) {
      const definition = profileDefinitionForProtocol(profileId, "1.1.0");
      expect(definition.protocol_version).toBe("1.1.0");
      expect(definition.capabilities).not.toHaveProperty("parallel_task_execution");
    }
  });

  it("disables parallel execution for lite 1.3 and requires it for standard/governed 1.3", () => {
    expect(profileDefinitionForProtocol("lite", "1.3.0").capabilities.parallel_task_execution).toBe(
      "disabled",
    );
    expect(
      profileDefinitionForProtocol("standard", "1.3.0").capabilities.parallel_task_execution,
    ).toBe("required");
    expect(
      profileDefinitionForProtocol("governed", "1.3.0").capabilities.parallel_task_execution,
    ).toBe("required");
  });

  it("keeps the other capability modes identical across versions", () => {
    for (const profileId of ["lite", "standard", "governed"] as const) {
      const legacy = profileDefinitionForProtocol(profileId, "1.1.0");
      const current = profileDefinitionForProtocol(profileId, "1.3.0");
      for (const capabilityId of CAPABILITY_IDS_1_1) {
        expect(current.capabilities[capabilityId]).toBe(legacy.capabilities[capabilityId]);
      }
      expect(current.approval_policy_id).toBe(legacy.approval_policy_id);
    }
  });

  it("never rotates the legacy definition digests", () => {
    for (const profileId of ["lite", "standard", "governed"] as const) {
      expect(profileDefinitionForProtocol(profileId, "1.1.0").definition_digest).toBe(
        profileDefinition(profileId).definition_digest,
      );
    }
    expect(profileDefinitionForProtocol("lite", "1.1.0").definition_digest).toBe(
      LEGACY_LITE_DIGEST,
    );
    expect(PROFILE_DEFINITIONS.map((entry) => entry.definition_digest)).toEqual(
      ["lite", "standard", "governed"].map(
        (profileId) =>
          profileDefinitionForProtocol(profileId as "lite" | "standard" | "governed", "1.1.0")
            .definition_digest,
      ),
    );
  });

  it("seals distinct 1.3 digests instead of silently reusing the 1.1 ones", () => {
    expect(PROFILE_DEFINITIONS_1_3.map((entry) => entry.profile_id)).toEqual([
      "lite",
      "standard",
      "governed",
    ]);
    for (const profileId of ["lite", "standard", "governed"] as const) {
      const current = profileDefinitionForProtocol(profileId, "1.3.0");
      expect(current.protocol_version).toBe("1.3.0");
      expect(current.definition_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(current.definition_digest).not.toBe(
        profileDefinitionForProtocol(profileId, "1.1.0").definition_digest,
      );
    }
  });
});

describe("profileDefinitionVersionForProtocol", () => {
  it("keeps protocol 1.0-1.2 operations on the 1.1 definitions", () => {
    expect(profileDefinitionVersionForProtocol("1.0.0")).toBe("1.1.0");
    expect(profileDefinitionVersionForProtocol("1.1.0")).toBe("1.1.0");
    expect(profileDefinitionVersionForProtocol("1.2.0")).toBe("1.1.0");
    expect(profileDefinitionVersionForProtocol("1.3.0")).toBe("1.3.0");
  });

  it("fails closed on unknown protocol versions", () => {
    expect(() => profileDefinitionVersionForProtocol("9.9.9")).toThrow(ProfileRegistryError);
  });
});

describe("profileDefinitionByDigest", () => {
  it("resolves legacy definitions by their referenced digest", () => {
    const legacyStandardDigest = profileDefinitionForProtocol(
      "standard",
      "1.1.0",
    ).definition_digest;
    expect(profileDefinitionByDigest(legacyStandardDigest).protocol_version).toBe("1.1.0");
    expect(profileDefinitionByDigest(legacyStandardDigest).profile_id).toBe("standard");
    expect(profileDefinitionByDigest(LEGACY_LITE_DIGEST).profile_id).toBe("lite");
  });

  it("resolves 1.3 definitions by digest without confusing tiers", () => {
    const digest = profileDefinitionForProtocol("governed", "1.3.0").definition_digest;
    const definition = profileDefinitionByDigest(digest);
    expect(definition.protocol_version).toBe("1.3.0");
    expect(definition.profile_id).toBe("governed");
  });

  it("fails closed on unknown digests", () => {
    expect(() => profileDefinitionByDigest("f".repeat(64))).toThrow(ProfileRegistryError);
  });
});

describe("versioned profile definition schemas", () => {
  it("validates each version against its own strict schema", () => {
    const v11 = compileSchemaValidator(ProfileDefinitionV11Schema);
    const v13 = compileSchemaValidator(ProfileDefinitionV13Schema);
    for (const definition of PROFILE_DEFINITIONS) {
      expect(v11(definition), definition.profile_id).toEqual({ valid: true, errors: [] });
      expect(v13(definition).valid, definition.profile_id).toBe(false);
    }
    for (const definition of PROFILE_DEFINITIONS_1_3) {
      expect(v13(definition), definition.profile_id).toEqual({ valid: true, errors: [] });
      expect(v11(definition).valid, definition.profile_id).toBe(false);
    }
  });

  it("exposes ProfileDefinitionSchema as the reader union of both versions", () => {
    const reader = compileSchemaValidator(ProfileDefinitionSchema);
    for (const definition of [...PROFILE_DEFINITIONS, ...PROFILE_DEFINITIONS_1_3]) {
      expect(reader(definition), definition.profile_id).toEqual({ valid: true, errors: [] });
    }
  });

  it("rejects drifted definitions in both versions", () => {
    const v13 = compileSchemaValidator(ProfileDefinitionV13Schema);
    const governed = profileDefinitionForProtocol("governed", "1.3.0");
    const missingParallel = {
      ...governed,
      capabilities: Object.fromEntries(
        Object.entries(governed.capabilities).filter(([key]) => key !== "parallel_task_execution"),
      ),
    };
    expect(v13(missingParallel).valid).toBe(false);
    const v11 = compileSchemaValidator(ProfileDefinitionV11Schema);
    const legacy = profileDefinitionForProtocol("lite", "1.1.0");
    const smuggled = {
      ...legacy,
      capabilities: { ...legacy.capabilities, parallel_task_execution: "required" },
    };
    expect(v11(smuggled).valid).toBe(false);
  });
});
