import { describe, expect, it } from "vitest";

import { mergePolicyLayers } from "../../src/policy/evaluator.js";

import { field, layer } from "../policy/fixtures.js";
import {
  TddGrantError,
  assertTddPhaseGrantCurrent,
  issueTddPhaseGrant,
  tddPhaseWriteScopes,
} from "../../src/tdd/phase-grants.js";

/**
 * T15 phase grants (provable TDD design 8.3): every TDD phase gets its own
 * digest-bound grant; implementation unlocks only behind an accepted Red
 * proof, refactor behind Green; a resume re-issue is the same grant, never
 * a duplicate; a grant from another phase or a drifted policy is unusable.
 */
const POLICY = {
  test: ["tests/**"],
  test_config: ["vitest.config.ts"],
  production: ["src/**"],
  immutable: ["migrations/**"],
};

function effectivePolicy() {
  return mergePolicyLayers([
    layer("project", [
      field("paths.write.allow", "allow_intersection", ["src", "tests", "vitest.config.ts"]),
      field("paths.read.allow", "allow_intersection", [
        "src",
        "tests",
        "vitest.config.ts",
        "migrations",
      ]),
    ]),
  ]).effective;
}

function grantInput(state: Parameters<typeof issueTddPhaseGrant>[0]["state"]) {
  return {
    state,
    task_id: "task_01",
    policy: POLICY,
    budget: { steps: 10, tokens: 1000 },
    effective: effectivePolicy(),
  };
}

describe("tddPhaseWriteScopes", () => {
  it("maps each phase to its write scope", () => {
    expect(tddPhaseWriteScopes("baseline_guard", POLICY)).toEqual([]);
    expect(tddPhaseWriteScopes("test_authoring", POLICY)).toEqual(["tests/**", "vitest.config.ts"]);
    expect(tddPhaseWriteScopes("red_verification", POLICY)).toEqual([]);
    expect(tddPhaseWriteScopes("implementation", POLICY)).toEqual(["src/**"]);
    expect(tddPhaseWriteScopes("refactor", POLICY)).toEqual(["src/**"]);
  });
});

describe("issueTddPhaseGrant", () => {
  it("issues deterministic per-phase grants and reuses them on resume", () => {
    const first = issueTddPhaseGrant(grantInput("test_authoring"), []);
    expect(first.reused).toBe(false);
    expect(first.grant.write_paths).toEqual(["tests/**", "vitest.config.ts"]);

    const resumed = issueTddPhaseGrant(grantInput("test_authoring"), [first.grant]);
    expect(resumed.reused).toBe(true);
    expect(resumed.grant.digest).toBe(first.grant.digest);

    const other = issueTddPhaseGrant(grantInput("baseline_guard"), [first.grant]);
    expect(other.grant.grant_id).not.toBe(first.grant.grant_id);
  });

  it("unlocks implementation only behind an accepted Red proof", () => {
    expect(() => issueTddPhaseGrant(grantInput("implementation"), [])).toThrowError(TddGrantError);
    const unlocked = issueTddPhaseGrant(
      { ...grantInput("implementation"), proof_digest: "a".repeat(64) },
      [],
    );
    expect(unlocked.grant.write_paths).toEqual(["src/**"]);
  });

  it("rejects using a grant outside its phase or against a drifted policy", () => {
    const issued = issueTddPhaseGrant(grantInput("test_authoring"), []);
    expect(() =>
      assertTddPhaseGrantCurrent(issued.grant, {
        state: "implementation",
        task_id: "task_01",
        policy: POLICY,
      }),
    ).toThrowError(TddGrantError);
    expect(() =>
      assertTddPhaseGrantCurrent(issued.grant, {
        state: "test_authoring",
        task_id: "task_01",
        policy: POLICY,
      }),
    ).not.toThrow();
    expect(() =>
      assertTddPhaseGrantCurrent(issued.grant, {
        state: "test_authoring",
        task_id: "task_02",
        policy: POLICY,
      }),
    ).toThrowError(TddGrantError);
  });
});
