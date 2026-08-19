import { describe, expect, it } from "vitest";

import {
  BindingScopeError,
  CAPTURE_SCOPE_SLOTS,
  assertBindingScopesDisjoint,
  bindingScopeKey,
  modelSlotDefaultsForProfile,
} from "../../src/profile/model-slots.js";
import { PROFILE_IDS, type ProfileId } from "../../src/schema/profile.js";

function defaultFor(
  profileId: ProfileId,
  slotId: string,
  purpose?: string,
): { required: boolean; failure_mode: string } {
  const found = modelSlotDefaultsForProfile(profileId).find(
    (slot) => slot.slot_id === slotId && slot.purpose === purpose,
  );
  if (found === undefined) {
    throw new Error(`no slot default for ${profileId} ${slotId} ${purpose ?? ""}`);
  }
  return { required: found.required, failure_mode: found.failure_mode };
}

describe("model slot profile matrix", () => {
  it("gives every profile the eight protocol 1.1 slots in canonical order", () => {
    for (const profileId of PROFILE_IDS) {
      const slots = modelSlotDefaultsForProfile(profileId);
      expect(slots).toHaveLength(8);
      const keys = slots.map((slot) => bindingScopeKey(slot));
      expect([...keys].sort()).toEqual(keys);
    }
  });

  it("marks domain ports optional on Lite and required on Standard/Governed", () => {
    for (const slotId of [
      "impact_advisory",
      "design_review",
      "plan_proposal",
      "feedback_analysis",
    ]) {
      expect(defaultFor("lite", slotId)).toEqual({ required: false, failure_mode: "block" });
      expect(defaultFor("standard", slotId)).toEqual({ required: true, failure_mode: "block" });
      expect(defaultFor("governed", slotId)).toEqual({ required: true, failure_mode: "block" });
    }
  });

  it("marks grounded purposes per the profile matrix", () => {
    for (const purpose of ["project_discovery", "context_enrichment", "approval_brief"]) {
      expect(defaultFor("lite", "grounded_synthesis", purpose)).toEqual({
        required: false,
        failure_mode: "block",
      });
      expect(defaultFor("standard", "grounded_synthesis", purpose)).toEqual({
        required: true,
        failure_mode: "block",
      });
      expect(defaultFor("governed", "grounded_synthesis", purpose)).toEqual({
        required: true,
        failure_mode: "block",
      });
    }
  });

  it("never lets iteration_narrative block the snapshot, on any profile", () => {
    for (const profileId of PROFILE_IDS) {
      const narrative = defaultFor(profileId, "grounded_synthesis", "iteration_narrative");
      expect(narrative.failure_mode).toBe("projection_finding");
    }
    expect(defaultFor("lite", "grounded_synthesis", "iteration_narrative").required).toBe(false);
    expect(defaultFor("standard", "grounded_synthesis", "iteration_narrative")).toEqual({
      required: true,
      failure_mode: "projection_finding",
    });
    expect(defaultFor("governed", "grounded_synthesis", "iteration_narrative")).toEqual({
      required: true,
      failure_mode: "projection_finding",
    });
  });

  it("reserves exactly project_discovery and capture approval_brief for the capture scope", () => {
    expect(CAPTURE_SCOPE_SLOTS).toEqual([
      { slot_id: "grounded_synthesis", purpose: "approval_brief" },
      { slot_id: "grounded_synthesis", purpose: "project_discovery" },
    ]);
  });
});

describe("binding scope disjointness", () => {
  it("accepts capture-scope and operation-scope bindings that do not overlap", () => {
    expect(() =>
      assertBindingScopesDisjoint(
        [{ slot_id: "grounded_synthesis", purpose: "project_discovery" }],
        [
          { slot_id: "grounded_synthesis", purpose: "context_enrichment" },
          { slot_id: "plan_proposal" },
        ],
      ),
    ).not.toThrow();
  });

  it("rejects a slot/purpose held by both scopes", () => {
    expect(() =>
      assertBindingScopesDisjoint(
        [{ slot_id: "grounded_synthesis", purpose: "approval_brief" }],
        [{ slot_id: "grounded_synthesis", purpose: "approval_brief" }],
      ),
    ).toThrow(BindingScopeError);
    try {
      assertBindingScopesDisjoint(
        [{ slot_id: "grounded_synthesis", purpose: "project_discovery" }],
        [
          { slot_id: "impact_advisory" },
          { slot_id: "grounded_synthesis", purpose: "project_discovery" },
        ],
      );
      expect.unreachable("overlap must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BindingScopeError);
      expect((error as BindingScopeError).overlaps).toEqual([
        "grounded_synthesis:project_discovery",
      ]);
    }
  });
});
