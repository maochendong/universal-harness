import { describe, expect, it } from "vitest";

import { captureRequirements, type CaptureIdKind, type IntentInput } from "../../src/index.js";

function mint(): (kind: CaptureIdKind) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_t${String(next).padStart(2, "0")}`;
  };
}

function validIntent(overrides?: Partial<IntentInput>): IntentInput {
  return {
    text: "add a health endpoint",
    requirements: [
      {
        statement: "the service exposes GET /health",
        acceptance: [{ description: "GET /health returns 200", verification: "gate:http-check" }],
      },
    ],
    constraints: [{ statement: "no new runtime dependency", verification: "gate:dependency-scan" }],
    ...overrides,
  };
}

describe("captureRequirements", () => {
  it("converts a complete intent into a deterministic proposal", () => {
    const outcome = captureRequirements(validIntent(), { newId: mint() });

    expect(outcome.status).toBe("captured");
    if (outcome.status !== "captured") return;
    expect(outcome.proposal.intent).toEqual({ id: "intent_t01", text: "add a health endpoint" });
    expect(outcome.proposal.requirements).toEqual([
      {
        id: "requirement_t01",
        statement: "the service exposes GET /health",
        acceptance: [{ description: "GET /health returns 200", verification: "gate:http-check" }],
      },
    ]);
    expect(outcome.proposal.constraints).toEqual([
      {
        id: "constraint_t01",
        statement: "no new runtime dependency",
        verification: "gate:dependency-scan",
      },
    ]);
  });

  it("requires clarification when the intent text is missing", () => {
    const outcome = captureRequirements(validIntent({ text: "   " }), { newId: mint() });

    expect(outcome.status).toBe("clarification_required");
    if (outcome.status !== "clarification_required") return;
    expect(outcome.questions.map((question) => question.subject)).toContain("intent");
  });

  it("requires clarification when no requirement is given", () => {
    const outcome = captureRequirements(validIntent({ requirements: [] }), { newId: mint() });

    expect(outcome.status).toBe("clarification_required");
    if (outcome.status !== "clarification_required") return;
    expect(outcome.questions.map((question) => question.subject)).toContain("requirement");
  });

  it("requires clarification for a requirement without verifiable acceptance criteria", () => {
    const outcome = captureRequirements(
      validIntent({
        requirements: [{ statement: "the service exposes GET /health", acceptance: [] }],
      }),
      { newId: mint() },
    );

    expect(outcome.status).toBe("clarification_required");
    if (outcome.status !== "clarification_required") return;
    expect(outcome.questions).toEqual([
      {
        subject: "acceptance",
        index: 0,
        question: "requirement 1 has no acceptance criteria",
      },
    ]);
  });

  it("collects every blocking question in deterministic input order", () => {
    const outcome = captureRequirements(
      {
        text: "",
        requirements: [
          { statement: "", acceptance: [{ description: "", verification: "" }] },
          { statement: "second", acceptance: [{ description: "ok", verification: "" }] },
        ],
        constraints: [{ statement: "", verification: "" }],
      },
      { newId: mint() },
    );

    expect(outcome.status).toBe("clarification_required");
    if (outcome.status !== "clarification_required") return;
    expect(outcome.questions).toEqual([
      { subject: "intent", question: "intent text is required" },
      { subject: "requirement", index: 0, question: "requirement 1 is missing a statement" },
      {
        subject: "acceptance",
        index: 0,
        question: "acceptance criterion 1 of requirement 1 needs a description and a verification",
      },
      {
        subject: "acceptance",
        index: 1,
        question: "acceptance criterion 1 of requirement 2 needs a description and a verification",
      },
      {
        subject: "constraint",
        index: 0,
        question: "constraint 1 needs a statement and a verification",
      },
    ]);
  });

  it("produces identical proposals for identical input and id mint", () => {
    const first = captureRequirements(validIntent(), { newId: mint() });
    const second = captureRequirements(validIntent(), { newId: mint() });
    expect(first).toEqual(second);
  });
});
