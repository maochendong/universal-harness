import { describe, expect, it } from "vitest";

import { validateSchema } from "@universal-harness-internal/core";

import { FeedbackError } from "../../src/feedback/finding.js";
import {
  buildImprovementCandidate,
  improvementEdgeRecord,
  readImprovementContent,
  type ImprovementCandidateContent,
} from "../../src/feedback/improvement.js";

import { TIMESTAMP_CLOCK } from "./fixtures.js";

const CONTEXT = { actor: "workflow-engine", timestamp: "2026-08-11T00:00:00.000Z" } as const;

function content(overrides?: Partial<ImprovementCandidateContent>): ImprovementCandidateContent {
  return {
    target_kind: "evaluation",
    target_layer: "eval",
    failure_class: "repeat-tool-call",
    expected_behavior: "the run terminates with a typed repeat detection instead of looping",
    reproduction: ["run the repeat scenario with a stuck tool", "observe the repeat detector"],
    verification_method: "re-run the repeat evaluation case and require a correct_failure pass",
    source_rca_id: "rca_repeat",
    approved_secret_references: [],
    ...overrides,
  };
}

function candidate(contentOverrides?: Partial<ImprovementCandidateContent>) {
  return buildImprovementCandidate({
    id: "improvement_repeat-case",
    iterationId: "iteration_01",
    summary: "add a repeat-detection evaluation case",
    content: content(contentOverrides),
    clock: TIMESTAMP_CLOCK,
  });
}

/**
 * ImprovementCandidate (design 9.1 and principle 8, plan Task 21, completion
 * rule 18): reusable experience becomes a reviewable candidate that is
 * reproducible, names its failure class and verification method, and carries
 * no unapproved secret references. It is always born proposed.
 */
describe("buildImprovementCandidate", () => {
  it("builds a schema-valid proposed candidate with a deterministic digest", () => {
    const record = candidate();
    expect(validateSchema("feedback", record).valid).toBe(true);
    expect(record.type).toBe("ImprovementCandidate");
    expect(record.status).toBe("proposed");
    expect(candidate().digest).toBe(record.digest);
    expect(readImprovementContent(record).failure_class).toBe("repeat-tool-call");
  });

  it("requires reproducibility, expected behavior, failure class and verification", () => {
    expect(() => candidate({ reproduction: [] })).toThrowError(
      expect.objectContaining({ kind: "invalid_improvement_candidate" }) as FeedbackError,
    );
    expect(() => candidate({ expected_behavior: "  " })).toThrowError(FeedbackError);
    expect(() => candidate({ failure_class: "" })).toThrowError(FeedbackError);
    expect(() => candidate({ verification_method: "" })).toThrowError(FeedbackError);
  });

  it("rejects unapproved secret references and accepts approved ones", () => {
    const withSecret = {
      ...content(),
      reproduction: [{ $env: "PROVIDER_KEY" }],
    } as unknown as ImprovementCandidateContent;
    expect(() =>
      buildImprovementCandidate({
        id: "improvement_secret",
        iterationId: "iteration_01",
        summary: "candidate with a secret reference",
        content: withSecret,
        clock: TIMESTAMP_CLOCK,
      }),
    ).toThrowError(
      expect.objectContaining({ kind: "invalid_improvement_candidate" }) as FeedbackError,
    );

    const approved = buildImprovementCandidate({
      id: "improvement_secret",
      iterationId: "iteration_01",
      summary: "candidate with an approved secret reference",
      content: { ...withSecret, approved_secret_references: ["PROVIDER_KEY"] },
      clock: TIMESTAMP_CLOCK,
    });
    expect(readImprovementContent(approved).approved_secret_references).toEqual(["PROVIDER_KEY"]);
  });
});

describe("improvementEdgeRecord", () => {
  it("proposes a PROPOSES_CHANGE_TO edge to the target node", () => {
    const edge = improvementEdgeRecord(candidate(), "evaluationcase_repeat", CONTEXT);
    expect(validateSchema("edge", edge).valid).toBe(true);
    expect(edge.type).toBe("PROPOSES_CHANGE_TO");
    expect(edge.status).toBe("proposed");
    expect(edge.target_id).toBe("evaluationcase_repeat");
  });
});
