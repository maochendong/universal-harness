import { describe, expect, it } from "vitest";

import { criterionSemanticDigest } from "../../src/proposal/digest.js";

const BASE = {
  requirement_id: "prd-requirement_01K1ABCDEFGHIJKLMNO",
  precondition: "a monthly report exists",
  action: "the user exports the report as CSV",
  observable_outcome: "a CSV file containing the report rows is produced",
  verification_intent: "compare the exported CSV rows with the report data",
  test_first_example: "given a report, exporting produces a matching CSV",
  scenario_kind: "primary" as const,
};

describe("criterionSemanticDigest", () => {
  it("is deterministic and stable for identical business semantics", () => {
    expect(criterionSemanticDigest(BASE)).toMatch(/^[a-f0-9]{64}$/u);
    expect(criterionSemanticDigest(BASE)).toBe(criterionSemanticDigest({ ...BASE }));
  });

  it("ignores source bindings, criterion id and other non-semantic fields", () => {
    // The digest input carries only business fields by construction; passing
    // extra fields (bindings, ids, timestamps) must not change the digest.
    const withNoise = {
      ...BASE,
      criterion_id: "prd-criterion_OTHER",
      source_bindings: [
        { source_kind: "intent", source_id: "intent", source_digest: "0".repeat(64) },
      ],
      generated_at: "2026-08-19T00:00:00.000Z",
    };
    expect(criterionSemanticDigest(withNoise)).toBe(criterionSemanticDigest(BASE));
  });

  it("normalizes newlines and surrounding whitespace", () => {
    const messy = {
      ...BASE,
      precondition: "  a monthly report exists\r\n",
      action: "\r\nthe user exports the report as CSV\r\n",
    };
    expect(criterionSemanticDigest(messy)).toBe(criterionSemanticDigest(BASE));
  });

  it("treats a missing test_first_example as null but distinct from a real example", () => {
    const withoutExample = { ...BASE };
    Reflect.deleteProperty(withoutExample, "test_first_example");
    const missing = criterionSemanticDigest(withoutExample);
    const blank = criterionSemanticDigest({ ...withoutExample, test_first_example: "  \r\n" });
    expect(missing).toBe(blank);
    expect(missing).not.toBe(criterionSemanticDigest(BASE));
  });

  it.each([
    ["requirement_id", "prd-requirement_02K2ABCDEFGHIJKLMNO"],
    ["precondition", "no report exists"],
    ["action", "the user archives the report"],
    ["observable_outcome", "a PDF file is produced"],
    ["verification_intent", "compare the exported rows with the source data"],
    ["test_first_example", "given no report, exporting is rejected"],
  ] as const)("changes when the business field %s changes", (field, value) => {
    expect(criterionSemanticDigest({ ...BASE, [field]: value })).not.toBe(
      criterionSemanticDigest(BASE),
    );
  });

  it("changes when the scenario kind changes", () => {
    expect(criterionSemanticDigest({ ...BASE, scenario_kind: "failure" as const })).not.toBe(
      criterionSemanticDigest(BASE),
    );
  });
});
