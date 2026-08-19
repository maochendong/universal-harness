import { describe, expect, it } from "vitest";

import {
  ProfileSelectionError,
  resolveIterationProfile,
  resolveProfileSelection,
} from "../../src/profile/selection.js";
import { createProjectProfileRecord } from "../../src/profile/records.js";

const DIGEST_A = "a".repeat(64);

describe("profile selection", () => {
  it("returns input_required for non-interactive new/adopt without --profile", async () => {
    const outcome = await resolveProfileSelection({ interactive: false });
    expect(outcome).toEqual({
      status: "input_required",
      reason: "profile_required",
      options: ["lite", "standard", "governed"],
    });
  });

  it("accepts an explicit --profile and never infers one from the project", async () => {
    await expect(
      resolveProfileSelection({ explicit: "governed", interactive: false }),
    ).resolves.toEqual({ status: "selected", profile_id: "governed", source: "explicit" });
    await expect(
      resolveProfileSelection({ explicit: "turbo", interactive: false }),
    ).rejects.toThrow(ProfileSelectionError);
  });

  it("uses the interactive chooser only in interactive sessions", async () => {
    let offered: readonly string[] = [];
    const outcome = await resolveProfileSelection({
      interactive: true,
      choose: (options) => {
        offered = options;
        return Promise.resolve("standard");
      },
    });
    expect(outcome).toEqual({ status: "selected", profile_id: "standard", source: "interactive" });
    expect([...offered]).toEqual(["lite", "standard", "governed"]);

    // A dismissed prompt (EOF/Ctrl-C) never becomes a silent default.
    const dismissed = await resolveProfileSelection({
      interactive: true,
      choose: () => Promise.resolve(null),
    });
    expect(dismissed.status).toBe("input_required");
    const invalid = await resolveProfileSelection({
      interactive: true,
      choose: () => Promise.resolve("everything"),
    });
    expect(invalid.status).toBe("input_required");
  });

  it("resolves iterate against the current profile revision", () => {
    expect(resolveIterationProfile(undefined)).toEqual({
      status: "input_required",
      reason: "profile_required",
      options: ["lite", "standard", "governed"],
      migration: "legacy_project_without_profile",
    });

    const record = createProjectProfileRecord({
      project_id: "project_demo-app",
      revision: 3,
      profile_id: "standard",
      policy_digest: DIGEST_A,
      actor: "human:reviewer",
      effective_from: "2026-08-19T00:00:00.000Z",
    });
    expect(resolveIterationProfile(record)).toEqual({ status: "resolved", profile: record });
  });
});
