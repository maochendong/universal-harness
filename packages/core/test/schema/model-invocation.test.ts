import { describe, expect, it } from "vitest";

import {
  MODEL_INVOCATION_STATES,
  ModelInvocationRecordSchema,
  ModelPortFailureSchema,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  compileSchemaValidator,
  sealRecordEnvelope,
} from "../../src/index.js";
import { MODEL_INVOCATION_FAILURE_CODES } from "../../src/prompt/failure-mapping.js";

const validateInvocation = compileSchemaValidator(ModelInvocationRecordSchema);
const validateFailure = compileSchemaValidator(ModelPortFailureSchema);

function plannedRecord() {
  return sealRecordEnvelope({
    protocol_version: "1.1.0",
    record_kind: "model_invocation" as const,
    invocation_id: "invocation_01K1TEST",
    conversation_id: "conversation_01K1TEST",
    run_id: "run_01K1TEST",
    attempt: 1,
    revision: 1,
    port_id: "prd_proposal",
    prompt_contract_id: "harness:prompt:prd-proposal",
    prompt_contract_version: "1.0.0",
    prompt_contract_digest: "a".repeat(64),
    output_schema_id: "prd-proposal-draft",
    output_schema_digest: "b".repeat(64),
    profile_overlay_digest: "c".repeat(64),
    policy_overlay_digest: "d".repeat(64),
    input_bundle_digest: "e".repeat(64),
    compiled_prompt_digest: "f".repeat(64),
    provider_identity: "provider_anthropic",
    config_digest: "0".repeat(64),
    budget_profile: "capture-standard",
    cache_key: "1".repeat(64),
    state: "planned" as const,
  });
}

describe("model invocation record schema", () => {
  it("is registered in the protocol 1.1 registry", () => {
    const documents = PROTOCOL_1_1_SCHEMA_REGISTRY.documents();
    expect(documents["model-invocation.schema.json"]).toBeDefined();
    expect(documents["model-port-failure.schema.json"]).toBeDefined();
  });

  it("accepts a fully pinned planned invocation", () => {
    const result = validateInvocation(plannedRecord());
    expect(result.valid).toBe(true);
  });

  it("rejects unknown fields, unknown states and malformed digests", () => {
    const record = plannedRecord() as Record<string, unknown>;
    expect(validateInvocation({ ...record, system_prompt: "override" }).valid).toBe(false);
    expect(validateInvocation({ ...record, state: "guessed" }).valid).toBe(false);
    expect(validateInvocation({ ...record, compiled_prompt_digest: "xyz" }).valid).toBe(false);
  });

  it("pins every protocol state in order of the lifecycle", () => {
    expect([...MODEL_INVOCATION_STATES]).toEqual([
      "planned",
      "started",
      "completed",
      "failed",
      "validated",
      "consumed",
      "invalidated",
    ]);
  });

  it("accepts only the fixed invocation failure codes on the failure payload", () => {
    for (const code of MODEL_INVOCATION_FAILURE_CODES) {
      expect(validateFailure({ code, summary: "summary", retryable: false }).valid).toBe(true);
    }
    expect(
      validateFailure({ code: "prompt_contract_required", summary: "s", retryable: false }).valid,
    ).toBe(false);
    expect(
      validateFailure({ code: "citation_missing", summary: "s", retryable: false }).valid,
    ).toBe(false);
  });
});
