import { describe, expect, it } from "vitest";

import {
  compileCriterionAssertions,
  criterionAssertionId,
  validateCriterionAssertionCoverage,
  type CriterionAssertionDescriptor,
} from "../../src/plan/assertions.js";

/**
 * T13 Criterion → Assertion compilation (provable TDD design 7.1, managed
 * PRD capture 13.1): every accepted atomic criterion compiles to exactly
 * one criterion_assertion whose identity derives only from the criterion
 * id, its semantic digest and the assertion schema version. The accepted
 * PRD digest never enters the identity, recompiling the same semantics is
 * stable, and a criterion with multiple independently verdictable outcomes
 * can never be split into multiple business assertions downstream.
 */
const digest = (letter: string) => letter.repeat(64);

const CRITERIA = [
  {
    criterion_id: "criterion_01K1AC1",
    criterion_semantic_digest: digest("a"),
    requirement_id: "requirement_01K1REQ",
    test_node_id: "test_01K1T01",
  },
  {
    criterion_id: "criterion_01K1AC2",
    criterion_semantic_digest: digest("b"),
    requirement_id: "requirement_01K1REQ",
    test_node_id: "test_01K1T02",
  },
] as const;

describe("criterionAssertionId", () => {
  it("derives the identity from criterion id, semantic digest and schema version only", () => {
    const id = criterionAssertionId({
      criterion_id: "criterion_01K1AC1",
      criterion_semantic_digest: digest("a"),
    });
    expect(id.startsWith("criterion-assertion_")).toBe(true);
    // Stable under recompilation of the same semantics.
    expect(
      criterionAssertionId({
        criterion_id: "criterion_01K1AC1",
        criterion_semantic_digest: digest("a"),
      }),
    ).toBe(id);
    // A semantic change rotates only that criterion's assertion.
    const rotated = criterionAssertionId({
      criterion_id: "criterion_01K1AC1",
      criterion_semantic_digest: digest("c"),
    });
    expect(rotated).not.toBe(id);
    expect(
      criterionAssertionId({
        criterion_id: "criterion_01K1AC2",
        criterion_semantic_digest: digest("b"),
      }),
    ).not.toBe(rotated);
  });
});

describe("compileCriterionAssertions", () => {
  it("compiles every accepted criterion to exactly one bound assertion", () => {
    const descriptors = compileCriterionAssertions([...CRITERIA]);
    expect(descriptors).toHaveLength(2);
    for (const descriptor of descriptors) {
      expect(descriptor.assertion_kind).toBe("criterion_assertion");
      expect(descriptor.assertion_id).toBe(
        criterionAssertionId({
          criterion_id: descriptor.acceptance_criterion_id,
          criterion_semantic_digest: descriptor.criterion_semantic_digest,
        }),
      );
    }
    expect(descriptors[0]?.test_node_id).toBe("test_01K1T01");
  });

  it("binds the primary test strategy only when design governance supplies one", () => {
    const withStrategy = compileCriterionAssertions([...CRITERIA], {
      primary_strategies: { "criterion_01K1AC1#test_01K1T01": "designartifact_01K1TST" },
    });
    expect(withStrategy[0]?.primary_test_strategy_id).toBe("designartifact_01K1TST");
    expect(withStrategy[1]?.primary_test_strategy_id).toBeUndefined();

    const without = compileCriterionAssertions([...CRITERIA]);
    expect(without[0]?.primary_test_strategy_id).toBeUndefined();
  });
});

describe("validateCriterionAssertionCoverage", () => {
  function descriptors(): CriterionAssertionDescriptor[] {
    return compileCriterionAssertions([...CRITERIA]);
  }

  it("accepts a 1:1 compilation with exactly one owning task each", () => {
    const compiled = descriptors();
    expect(
      validateCriterionAssertionCoverage({
        descriptors: compiled,
        accepted_criteria: CRITERIA.map((criterion) => ({
          criterion_id: criterion.criterion_id,
          criterion_semantic_digest: criterion.criterion_semantic_digest,
        })),
        task_assertion_assignments: {
          task_01: [compiled[0]?.assertion_id ?? ""],
          task_02: [compiled[1]?.assertion_id ?? ""],
        },
      }),
    ).toEqual([]);
  });

  it("rejects a missing, duplicated or identity-drifting assertion", () => {
    const compiled = descriptors();
    const missing = validateCriterionAssertionCoverage({
      descriptors: [compiled[0] as CriterionAssertionDescriptor],
      accepted_criteria: CRITERIA.map((criterion) => ({
        criterion_id: criterion.criterion_id,
        criterion_semantic_digest: criterion.criterion_semantic_digest,
      })),
      task_assertion_assignments: { task_01: [compiled[0]?.assertion_id ?? ""] },
    });
    expect(missing.map((issue) => issue.code)).toContain("missing_assertion");

    const forged: CriterionAssertionDescriptor = {
      ...(compiled[0] as CriterionAssertionDescriptor),
      assertion_id: "criterion-assertion_forged",
    };
    const drifted = validateCriterionAssertionCoverage({
      descriptors: [forged, compiled[1] as CriterionAssertionDescriptor],
      accepted_criteria: CRITERIA.map((criterion) => ({
        criterion_id: criterion.criterion_id,
        criterion_semantic_digest: criterion.criterion_semantic_digest,
      })),
      task_assertion_assignments: {
        task_01: [forged.assertion_id],
        task_02: [compiled[1]?.assertion_id ?? ""],
      },
    });
    expect(drifted.map((issue) => issue.code)).toContain("identity_mismatch");
  });

  it("rejects zero or multiple owning tasks for a criterion assertion", () => {
    const compiled = descriptors();
    const unowned = validateCriterionAssertionCoverage({
      descriptors: compiled,
      accepted_criteria: CRITERIA.map((criterion) => ({
        criterion_id: criterion.criterion_id,
        criterion_semantic_digest: criterion.criterion_semantic_digest,
      })),
      task_assertion_assignments: { task_01: [compiled[0]?.assertion_id ?? ""] },
    });
    expect(unowned.map((issue) => issue.code)).toContain("unowned_assertion");

    const shared = validateCriterionAssertionCoverage({
      descriptors: compiled,
      accepted_criteria: CRITERIA.map((criterion) => ({
        criterion_id: criterion.criterion_id,
        criterion_semantic_digest: criterion.criterion_semantic_digest,
      })),
      task_assertion_assignments: {
        task_01: [compiled[0]?.assertion_id ?? ""],
        task_02: [compiled[0]?.assertion_id ?? "", compiled[1]?.assertion_id ?? ""],
      },
    });
    expect(shared.map((issue) => issue.code)).toContain("multiple_owners");
  });

  it("never lets a task_internal assertion pose as criterion coverage", () => {
    const compiled = descriptors();
    const internalForged = {
      assertion_id: "assertion_internal_01",
      assertion_kind: "task_internal_assertion" as const,
      acceptance_criterion_id: "criterion_01K1AC2",
      criterion_semantic_digest: digest("b"),
      test_node_id: "test_01K1T02",
      requirement_id: "requirement_01K1REQ",
    };
    const issues = validateCriterionAssertionCoverage({
      descriptors: [compiled[0] as CriterionAssertionDescriptor, internalForged],
      accepted_criteria: CRITERIA.map((criterion) => ({
        criterion_id: criterion.criterion_id,
        criterion_semantic_digest: criterion.criterion_semantic_digest,
      })),
      task_assertion_assignments: {
        task_01: [compiled[0]?.assertion_id ?? "", internalForged.assertion_id],
      },
    });
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("internal_assertion_overreach");
    expect(codes).toContain("missing_assertion");
  });
});
