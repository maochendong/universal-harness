import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";

/**
 * Criterion → Assertion authoritative compilation (provable TDD design 7.1,
 * managed PRD capture 13.1, plan T13). This is a Kernel invariant of every
 * Protocol 1.1 plan, independent of strict_tdd: every accepted atomic
 * criterion compiles to exactly one `criterion_assertion` whose identity is
 * fixed by the `harness:criterion-assertion` formula — criterion id,
 * criterion semantic digest and assertion schema version. The accepted PRD
 * digest binds plans and contracts but never enters assertion identity, so
 * unchanged criteria keep their assertions across PRD revisions while a
 * semantic change rotates exactly one id. No planner adapter may split,
 * merge or re-mint these identities.
 */
export const ASSERTION_SCHEMA_VERSION = "criterion-assertion.v1" as const;

export function criterionAssertionId(input: {
  readonly criterion_id: string;
  readonly criterion_semantic_digest: string;
}): string {
  return domainRecordId({
    domain_tag: "criterion_assertion",
    id_prefix: "criterion-assertion",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: {
      criterion_id: input.criterion_id,
      criterion_semantic_digest: input.criterion_semantic_digest,
      assertion_schema_version: ASSERTION_SCHEMA_VERSION,
    },
  });
}

/** The Harness-compiled canonical assertion a planner may only allocate. */
export interface CriterionAssertionDescriptor {
  readonly assertion_id: string;
  readonly assertion_kind: "criterion_assertion";
  readonly acceptance_criterion_id: string;
  readonly criterion_semantic_digest: string;
  readonly requirement_id: string;
  readonly test_node_id: string;
  /** Bound only when design governance supplies a primary test strategy. */
  readonly primary_test_strategy_id?: string;
}

export function compileCriterionAssertions(
  criteria: readonly {
    readonly criterion_id: string;
    readonly criterion_semantic_digest: string;
    readonly requirement_id: string;
    readonly test_node_id: string;
  }[],
  options?: {
    /** `(criterion_id, test_node_id)` → primary test strategy asset id. */
    readonly primary_strategies?: Readonly<Record<string, string>>;
  },
): CriterionAssertionDescriptor[] {
  return criteria.map((criterion) => {
    const strategy =
      options?.primary_strategies?.[`${criterion.criterion_id}#${criterion.test_node_id}`];
    return {
      assertion_id: criterionAssertionId({
        criterion_id: criterion.criterion_id,
        criterion_semantic_digest: criterion.criterion_semantic_digest,
      }),
      assertion_kind: "criterion_assertion",
      acceptance_criterion_id: criterion.criterion_id,
      criterion_semantic_digest: criterion.criterion_semantic_digest,
      requirement_id: criterion.requirement_id,
      test_node_id: criterion.test_node_id,
      ...(strategy === undefined ? {} : { primary_test_strategy_id: strategy }),
    };
  });
}

export const ASSERTION_COVERAGE_ISSUE_CODES = [
  "missing_assertion",
  "duplicate_assertion",
  "identity_mismatch",
  "semantic_drift",
  "unowned_assertion",
  "multiple_owners",
  "internal_assertion_overreach",
] as const;
export type AssertionCoverageIssueCode = (typeof ASSERTION_COVERAGE_ISSUE_CODES)[number];

export interface AssertionCoverageIssue {
  readonly code: AssertionCoverageIssueCode;
  readonly message: string;
  readonly target_id?: string;
}

interface AssertableDescriptor {
  readonly assertion_id: string;
  readonly assertion_kind: "criterion_assertion" | "task_internal_assertion";
  readonly acceptance_criterion_id?: string;
  readonly criterion_semantic_digest?: string;
}

/**
 * The plan-level coverage invariants of provable TDD design 7.1/7.3: the
 * descriptor set covers every accepted criterion exactly once with the
 * formula-derived identity and the current semantic digest, and every
 * criterion assertion has exactly one owning task. `task_internal`
 * assertions may exist for engineering constraints but can never satisfy or
 * impersonate criterion coverage.
 */
export function validateCriterionAssertionCoverage(input: {
  readonly descriptors: readonly AssertableDescriptor[];
  readonly accepted_criteria: readonly {
    readonly criterion_id: string;
    readonly criterion_semantic_digest: string;
  }[];
  /** owning task id → assertion ids it carries. */
  readonly task_assertion_assignments: Readonly<Record<string, readonly string[]>>;
}): AssertionCoverageIssue[] {
  const issues: AssertionCoverageIssue[] = [];
  const issue = (code: AssertionCoverageIssueCode, message: string, targetId?: string) =>
    issues.push({ code, message, ...(targetId === undefined ? {} : { target_id: targetId }) });

  const criterionAssertions = input.descriptors.filter(
    (descriptor) => descriptor.assertion_kind === "criterion_assertion",
  );
  const byCriterion = new Map<string, AssertableDescriptor[]>();
  for (const descriptor of criterionAssertions) {
    const criterionId = descriptor.acceptance_criterion_id ?? "";
    byCriterion.set(criterionId, [...(byCriterion.get(criterionId) ?? []), descriptor]);
  }
  for (const descriptor of input.descriptors) {
    if (
      descriptor.assertion_kind === "task_internal_assertion" &&
      (descriptor.acceptance_criterion_id !== undefined ||
        descriptor.criterion_semantic_digest !== undefined)
    ) {
      issue(
        "internal_assertion_overreach",
        `task_internal assertion ${descriptor.assertion_id} carries criterion bindings; it can never satisfy criterion coverage`,
        descriptor.assertion_id,
      );
    }
  }

  for (const criterion of input.accepted_criteria) {
    const matches = byCriterion.get(criterion.criterion_id) ?? [];
    if (matches.length === 0) {
      issue(
        "missing_assertion",
        `accepted criterion ${criterion.criterion_id} compiled to no criterion_assertion`,
        criterion.criterion_id,
      );
      continue;
    }
    if (matches.length > 1) {
      issue(
        "duplicate_assertion",
        `criterion ${criterion.criterion_id} compiled to ${matches.length} assertions; 1:N business assertions are forbidden`,
        criterion.criterion_id,
      );
    }
    for (const descriptor of matches) {
      const expected = criterionAssertionId({
        criterion_id: criterion.criterion_id,
        criterion_semantic_digest: criterion.criterion_semantic_digest,
      });
      if (descriptor.assertion_id !== expected) {
        issue(
          "identity_mismatch",
          `assertion ${descriptor.assertion_id} does not match the harness:criterion-assertion formula for ${criterion.criterion_id}`,
          descriptor.assertion_id,
        );
      }
      if (descriptor.criterion_semantic_digest !== criterion.criterion_semantic_digest) {
        issue(
          "semantic_drift",
          `assertion ${descriptor.assertion_id} binds a stale semantic digest for ${criterion.criterion_id}`,
          descriptor.assertion_id,
        );
      }
    }
  }

  const owners = new Map<string, number>();
  for (const assertionIds of Object.values(input.task_assertion_assignments)) {
    for (const assertionId of assertionIds) {
      owners.set(assertionId, (owners.get(assertionId) ?? 0) + 1);
    }
  }
  for (const descriptor of criterionAssertions) {
    const count = owners.get(descriptor.assertion_id) ?? 0;
    if (count === 0) {
      issue(
        "unowned_assertion",
        `criterion assertion ${descriptor.assertion_id} has no owning task`,
        descriptor.assertion_id,
      );
    } else if (count > 1) {
      issue(
        "multiple_owners",
        `criterion assertion ${descriptor.assertion_id} is owned by ${count} tasks`,
        descriptor.assertion_id,
      );
    }
  }

  return issues.sort((left, right) => left.code.localeCompare(right.code));
}
