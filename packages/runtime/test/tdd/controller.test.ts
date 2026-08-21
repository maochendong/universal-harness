import { describe, expect, it } from "vitest";

import {
  acceptBaselineEvidence,
  acceptGreenEvidence,
  acceptRedEvidence,
  buildTddCycleRecord,
  createTddCycle,
  freezeTestPatch,
  matchFailureOracle,
  type StructuredTestResult,
} from "../../src/tdd/controller.js";

/**
 * T16 TddController evidence acceptance (provable TDD design 9.2/9.3):
 * RedEvidence forms only from the bound baseline, the frozen patch, the
 * contract gate/framework/environment and a structured failure that hits a
 * target assertion and matches the Failure Oracle. Syntax errors, timeouts,
 * missing results and self-reports never form evidence.
 */
const digest = (letter: string) => letter.repeat(64);
const ASSERTION = "criterion-assertion_01K1AS1";
const POLICY = { test: ["tests/**"], test_config: [], production: ["src/**"], immutable: [] };
const ORACLE = {
  selector_ids: ["tests/items.test.ts"],
  allowed_failure_kinds: ["assertion_failure", "expected_exception_not_thrown"],
  assertion_ids: [ASSERTION],
};

function cycle() {
  return createTddCycle({
    task_id: "task_01",
    assertion_ids: [ASSERTION],
    contract_digest: digest("9"),
    repository_baseline: "deadbeef",
  });
}

function structuredResult(runs: StructuredTestResult["runs"]): StructuredTestResult {
  return { outcome: "structured", runs };
}

function redInput(patchDigest: string) {
  return {
    test_patch_digest: patchDigest,
    target_gate_binding_digest: digest("3"),
    framework_profile_digest: digest("f"),
    executor_environment_digest: digest("4"),
    observed_write_set_digest: digest("5"),
    grant_digest: digest("6"),
    oracle: ORACLE,
    result: structuredResult([
      {
        selector_id: "tests/items.test.ts",
        status: "failed" as const,
        assertion_id: ASSERTION,
        failure_kind: "assertion_failure",
      },
    ]),
    output_artifact: { locator: "artifacts/tdd/out.log", digest: digest("7") },
  };
}

function driveToRed() {
  let view = cycle();
  const baseline = acceptBaselineEvidence(view, {
    gate_passed: true,
    target_gate_binding_digest: digest("3"),
    framework_profile_digest: digest("f"),
    executor_environment_digest: digest("4"),
    grant_digest: digest("1"),
    observed_write_set_digest: digest("0"),
    output_artifact: { locator: "artifacts/tdd/base.log", digest: digest("8") },
  });
  expect(baseline.issues).toEqual([]);
  view = baseline.next;
  const patch = freezeTestPatch(
    view,
    [{ path: "tests/items.test.ts", content: "the failing test" }],
    POLICY,
  );
  expect(patch.issues).toEqual([]);
  view = patch.next;
  const red = acceptRedEvidence(view, redInput(patch.patch_digest));
  expect(red.issues).toEqual([]);
  return { view: red.next, patchDigest: patch.patch_digest };
}

describe("cycle state machine", () => {
  it("walks contract_ready to cycle_completed with attempt ordinals", () => {
    const { view, patchDigest } = driveToRed();
    expect(view.state).toBe("implementation");
    const green = acceptGreenEvidence(view, {
      ...redInput(patchDigest),
      result: structuredResult([
        { selector_id: "tests/items.test.ts", status: "passed" as const, assertion_id: ASSERTION },
      ]),
      production_write_set: ["src/items.ts"],
      implementation_write_scopes: ["src/**"],
      implementation_revision: "cafe01",
    });
    expect(green.issues).toEqual([]);
    expect(green.next.state).toBe("cycle_completed");
    const record = buildTddCycleRecord(green.next);
    expect(record.status).toBe("completed");
    expect(record.attempt_ordinal).toBe(1);
    expect(record.red_evidence_digest).toBeDefined();
    expect(record.green_evidence_digest).toBeDefined();
  });

  it("blocks the cycle on a failed baseline gate with pre_existing_failure", () => {
    const baseline = acceptBaselineEvidence(cycle(), {
      gate_passed: false,
      target_gate_binding_digest: digest("3"),
      framework_profile_digest: digest("f"),
      executor_environment_digest: digest("4"),
      grant_digest: digest("1"),
      observed_write_set_digest: digest("0"),
      output_artifact: { locator: "artifacts/tdd/base.log", digest: digest("8") },
    });
    expect(baseline.next.state).toBe("blocked");
    const record = buildTddCycleRecord(baseline.next);
    expect(record.status).toBe("blocked");
    expect(record.reason).toContain("pre_existing_failure");
  });
});

describe("red evidence acceptance", () => {
  it("rejects unstructured or masking outcomes", () => {
    const { view, patchDigest } = driveToBaselineAndPatch();
    for (const outcome of ["syntax_error", "timeout", "oom", "missing_result"] as const) {
      const attempt = acceptRedEvidence(view, {
        ...redInput(patchDigest),
        result: { outcome, runs: [] },
      });
      expect(attempt.issues.map((issue) => issue.code)).toContain("unstructured_result");
      expect(attempt.next.state).toBe(view.state);
    }
  });

  it("rejects oracle mismatches, wrong assertions and patch drift", () => {
    const { view, patchDigest } = driveToBaselineAndPatch();
    const wrongKind = acceptRedEvidence(view, {
      ...redInput(patchDigest),
      result: structuredResult([
        {
          selector_id: "tests/items.test.ts",
          status: "failed",
          assertion_id: ASSERTION,
          failure_kind: "missing_symbol",
        },
      ]),
    });
    expect(wrongKind.issues.map((issue) => issue.code)).toContain("oracle_mismatch");

    const wrongAssertion = acceptRedEvidence(view, {
      ...redInput(patchDigest),
      result: structuredResult([
        {
          selector_id: "tests/items.test.ts",
          status: "failed",
          assertion_id: "criterion-assertion_OTHER",
          failure_kind: "assertion_failure",
        },
      ]),
    });
    expect(wrongAssertion.issues.map((issue) => issue.code)).toContain("no_target_assertion");

    const drifted = acceptRedEvidence(view, redInput(digest("e")));
    expect(drifted.issues.map((issue) => issue.code)).toContain("patch_drift");
  });

  it("rejects green evidence that widens the production write set", () => {
    const { view, patchDigest } = driveToRed();
    const green = acceptGreenEvidence(view, {
      ...redInput(patchDigest),
      result: structuredResult([
        { selector_id: "tests/items.test.ts", status: "passed", assertion_id: ASSERTION },
      ]),
      production_write_set: ["src/items.ts", "migrations/001.sql"],
      implementation_write_scopes: ["src/**"],
      implementation_revision: "cafe01",
    });
    expect(green.issues.map((issue) => issue.code)).toContain("write_set_violation");
    expect(green.next.state).toBe("implementation");
  });
});

describe("matchFailureOracle", () => {
  it("matches restricted oracle facets without free regexes", () => {
    expect(
      matchFailureOracle({ failure_kind: "assertion_failure", assertion_id: ASSERTION }, ORACLE),
    ).toBe(true);
    expect(
      matchFailureOracle({ failure_kind: "missing_symbol", assertion_id: ASSERTION }, ORACLE),
    ).toBe(false);
    const withCodes = { ...ORACLE, expected_error_codes: ["E_RATE"] };
    expect(
      matchFailureOracle(
        { failure_kind: "assertion_failure", assertion_id: ASSERTION, error_code: "E_OTHER" },
        withCodes,
      ),
    ).toBe(false);
  });
});

function driveToBaselineAndPatch() {
  let view = cycle();
  view = acceptBaselineEvidence(view, {
    gate_passed: true,
    target_gate_binding_digest: digest("3"),
    framework_profile_digest: digest("f"),
    executor_environment_digest: digest("4"),
    grant_digest: digest("1"),
    observed_write_set_digest: digest("0"),
    output_artifact: { locator: "artifacts/tdd/base.log", digest: digest("8") },
  }).next;
  const patch = freezeTestPatch(
    view,
    [{ path: "tests/items.test.ts", content: "the failing test" }],
    POLICY,
  );
  return { view: patch.next, patchDigest: patch.patch_digest };
}
