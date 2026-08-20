import { describe, expect, it } from "vitest";

import { registeredOutputSchemaDigest } from "@universal-harness-internal/core";

import { validateModelOutput } from "../../src/model/result-validation.js";

const OUTPUT_SCHEMA_ID = "approval-brief-output";
const OUTPUT_SCHEMA_DIGEST = registeredOutputSchemaDigest(OUTPUT_SCHEMA_ID);

function validOutput(): string {
  return JSON.stringify({
    purpose: "approval_brief",
    schema_version: "approval-brief.v1",
    bundle_digest: "a".repeat(64),
    changes: [],
    risks: [],
    tradeoffs: [],
    open_questions: [],
  });
}

describe("validateModelOutput", () => {
  it("accepts output that validates against the pinned output schema", () => {
    const result = validateModelOutput({
      raw: validOutput(),
      output_schema_id: OUTPUT_SCHEMA_ID,
      output_schema_digest: OUTPUT_SCHEMA_DIGEST,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.value).toMatchObject({ purpose: "approval_brief" });
    }
  });

  it("rejects non-JSON, fenced or prose-padded output as invalid_output", () => {
    for (const raw of [
      "not json",
      `\`\`\`json\n${validOutput()}\n\`\`\``,
      `Here you go: ${validOutput()}`,
    ]) {
      const result = validateModelOutput({
        raw,
        output_schema_id: OUTPUT_SCHEMA_ID,
        output_schema_digest: OUTPUT_SCHEMA_DIGEST,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("invalid_output");
    }
  });

  it("rejects schema-invalid JSON as invalid_output", () => {
    const result = validateModelOutput({
      raw: JSON.stringify({ purpose: "approval_brief" }),
      output_schema_id: OUTPUT_SCHEMA_ID,
      output_schema_digest: OUTPUT_SCHEMA_DIGEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("invalid_output");
  });

  it("fails closed when the registered schema drifted from the pinned digest", () => {
    const result = validateModelOutput({
      raw: validOutput(),
      output_schema_id: OUTPUT_SCHEMA_ID,
      output_schema_digest: "0".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("version_mismatch");
  });

  it("fails closed on unknown output schemas", () => {
    const result = validateModelOutput({
      raw: validOutput(),
      output_schema_id: "no-such-schema",
      output_schema_digest: OUTPUT_SCHEMA_DIGEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("version_mismatch");
  });
});
