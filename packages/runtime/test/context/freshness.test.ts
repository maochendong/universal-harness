import { describe, expect, it } from "vitest";

import { sha256Hex, validateSchema } from "@universal-harness-internal/core";

import { compileContextBundle } from "../../src/context/compiler.js";
import {
  freshnessOf,
  invalidateContextBundle,
  isContextBundleStale,
  stalenessReasons,
  type CurrentContextState,
} from "../../src/context/freshness.js";

import { BINDINGS, candidate } from "./fixtures.js";

const CANDIDATES = [
  candidate("requirement_01", "Requirement", 1, "provide a health endpoint"),
  candidate("code_01", "CodeArtifact", 3, "export function health() {}"),
];

function compile() {
  return compileContextBundle({
    taskId: "task_01",
    goal: "ship the health endpoint",
    bindings: BINDINGS,
    tokenBudget: 4000,
    candidates: CANDIDATES,
  });
}

function currentState(overrides?: Partial<CurrentContextState>): CurrentContextState {
  return {
    sourceDigests: new Map(CANDIDATES.map((item) => [item.node.id, sha256Hex(item.content)])),
    bindings: BINDINGS,
    ...overrides,
  };
}

describe("freshnessOf", () => {
  it("compares digests", () => {
    expect(freshnessOf("a".repeat(64), "a".repeat(64))).toBe("fresh");
    expect(freshnessOf("a".repeat(64), "b".repeat(64))).toBe("stale");
  });
});

describe("stalenessReasons", () => {
  it("is fresh when every source and binding digest still holds", () => {
    const { manifest } = compile();
    expect(stalenessReasons(manifest, currentState())).toEqual([]);
    expect(isContextBundleStale(manifest, currentState())).toBe(false);
  });

  it("flags changed and vanished sources", () => {
    const { manifest } = compile();
    const changed = currentState({
      sourceDigests: new Map([
        ["requirement_01", sha256Hex("provide a health endpoint")],
        ["code_01", sha256Hex("export function health() { return ok; }")],
      ]),
    });
    expect(stalenessReasons(manifest, changed)).toEqual(["source code_01 digest changed"]);
    const vanished = currentState({
      sourceDigests: new Map([["requirement_01", sha256Hex("provide a health endpoint")]]),
    });
    expect(stalenessReasons(manifest, vanished)).toEqual(["source code_01 is no longer available"]);
  });

  it("flags requirement baseline, policy, plan and approval drift", () => {
    const { manifest } = compile();
    for (const [bindings, reason] of [
      [
        { ...BINDINGS, requirement_baseline_digest: "1".repeat(64) },
        "requirement baseline digest changed",
      ],
      [{ ...BINDINGS, policy_digest: "2".repeat(64) }, "policy digest changed"],
      [{ ...BINDINGS, plan_digest: "3".repeat(64) }, "execution plan digest changed"],
      [{ ...BINDINGS, approval_digests: [] }, "approval binding set changed"],
      [
        { ...BINDINGS, approval_digests: ["d".repeat(64), "e".repeat(64)] },
        "approval binding set changed",
      ],
    ] as const) {
      expect(stalenessReasons(manifest, currentState({ bindings }))).toEqual([reason]);
    }
  });
});

describe("invalidateContextBundle", () => {
  it("appends a stale successor record with the same identity", () => {
    const { record, manifest } = compile();
    expect(record.stale).toBe(false);
    const stale = invalidateContextBundle(record);
    expect(stale.stale).toBe(true);
    expect(stale.digest).toBe(record.digest);
    expect(stale.context_bundle_id).toBe(record.context_bundle_id);
    expect(stale.source_digests).toEqual(record.source_digests);
    expect(validateSchema("runtime", stale).valid).toBe(true);
    expect(manifest.content_digest).toBe(stale.digest);
  });

  it("collapses repeated invalidation into one pending state", () => {
    const { record } = compile();
    const stale = invalidateContextBundle(record);
    expect(invalidateContextBundle(stale)).toBe(stale);
  });

  it("requires recompilation to recover a fresh bundle after drift", () => {
    const { manifest, record } = compile();
    const changed = currentState({
      sourceDigests: new Map([
        ["requirement_01", sha256Hex("provide a health endpoint")],
        ["code_01", sha256Hex("export function health() { return ok; }")],
      ]),
    });
    expect(isContextBundleStale(manifest, changed)).toBe(true);
    const stale = invalidateContextBundle(record);
    expect(stale.stale).toBe(true);

    const recompiled = compileContextBundle({
      taskId: "task_01",
      goal: "ship the health endpoint",
      bindings: BINDINGS,
      tokenBudget: 4000,
      candidates: [
        CANDIDATES[0] ?? candidate("requirement_01", "Requirement", 1, "provide a health endpoint"),
        candidate("code_01", "CodeArtifact", 3, "export function health() { return ok; }"),
      ],
    });
    expect(recompiled.record.digest).not.toBe(record.digest);
    expect(recompiled.record.stale).toBe(false);
    expect(stalenessReasons(recompiled.manifest, changed)).toEqual([]);
  });
});
