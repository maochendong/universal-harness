import { describe, expect, it } from "vitest";

import {
  PROJECT_CONTEXT_CANDIDATE_PATHS,
  allowedSourceKindsForProfile,
  isSourceKindAllowedForProfile,
} from "../../src/context/source-kinds.js";
import { PROJECT_CONTEXT_SOURCE_KINDS } from "../../src/schema/context.js";
import { PROFILE_IDS } from "../../src/schema/profile.js";

/**
 * The Profile selection matrix (intent-to-prd design 14): Lite reads the
 * minimal manifest/README/Gate/Graph summaries, Standard adds ADR/API/Schema,
 * Governed adds Policy. The matrix is total over the registered source kinds
 * and fixed at compile time.
 */
describe("profile context source selection matrix", () => {
  it("grants Lite only manifest, readme, gate and graph sources", () => {
    expect([...allowedSourceKindsForProfile("lite")].sort()).toEqual([
      "gate",
      "graph",
      "manifest",
      "readme",
    ]);
  });

  it("grants Standard the Lite set plus adr, api and schema", () => {
    expect([...allowedSourceKindsForProfile("standard")].sort()).toEqual([
      "adr",
      "api",
      "gate",
      "graph",
      "manifest",
      "readme",
      "schema",
    ]);
  });

  it("grants Governed the Standard set plus policy", () => {
    expect([...allowedSourceKindsForProfile("governed")].sort()).toEqual(
      [...PROJECT_CONTEXT_SOURCE_KINDS].sort(),
    );
  });

  it("is a pure widening chain lite ⊆ standard ⊆ governed", () => {
    const lite = new Set(allowedSourceKindsForProfile("lite"));
    const standard = new Set(allowedSourceKindsForProfile("standard"));
    const governed = new Set(allowedSourceKindsForProfile("governed"));
    for (const kind of lite) expect(standard.has(kind)).toBe(true);
    for (const kind of standard) expect(governed.has(kind)).toBe(true);
  });

  it("never widens a request beyond the profile matrix", () => {
    expect(isSourceKindAllowedForProfile("lite", "policy")).toBe(false);
    expect(isSourceKindAllowedForProfile("lite", "adr")).toBe(false);
    expect(isSourceKindAllowedForProfile("standard", "policy")).toBe(false);
    expect(isSourceKindAllowedForProfile("standard", "adr")).toBe(true);
    expect(isSourceKindAllowedForProfile("governed", "policy")).toBe(true);
  });

  it("rejects unknown profile ids instead of defaulting", () => {
    for (const profileId of PROFILE_IDS) {
      expect(allowedSourceKindsForProfile(profileId).length).toBeGreaterThan(0);
    }
    expect(() => allowedSourceKindsForProfile("enterprise" as never)).toThrow();
  });

  it("returns canonically ordered kinds", () => {
    for (const profileId of PROFILE_IDS) {
      const kinds = allowedSourceKindsForProfile(profileId);
      expect([...kinds]).toEqual([...kinds].sort());
    }
  });

  it("declares candidate paths for every registered source kind", () => {
    for (const kind of PROJECT_CONTEXT_SOURCE_KINDS) {
      expect(PROJECT_CONTEXT_CANDIDATE_PATHS[kind].length).toBeGreaterThan(0);
    }
  });
});
