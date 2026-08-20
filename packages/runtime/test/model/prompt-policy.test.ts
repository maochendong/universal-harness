import { describe, expect, it } from "vitest";

import { PROMPT_POLICY_CLAUSE_IDS } from "@universal-harness-internal/core";

import { compilePrompt } from "../../src/model/prompt-compiler.js";
import {
  compilePolicyOverlay,
  type PromptPolicyOverlayClause,
} from "../../src/model/prompt-policy.js";
import {
  TEST_PROMPT_PORT_ID,
  TEST_PROMPT_VERSION,
  createTestRegistry,
  testInputBundle,
} from "./fixtures.js";

function compileWithPolicy(policyOverlay: readonly PromptPolicyOverlayClause[]) {
  return compilePrompt({
    registry: createTestRegistry(),
    selector: { port_id: TEST_PROMPT_PORT_ID, prompt_version: TEST_PROMPT_VERSION },
    profile: "standard",
    policy_overlay: policyOverlay,
    input_bundle: testInputBundle(),
  });
}

describe("policy overlay compilation", () => {
  it("compiles registered clauses deterministically and order-invariantly", () => {
    const first = compilePolicyOverlay([
      { clause_id: "require_security_negative_paths" },
      { clause_id: "require_migration_analysis" },
    ]);
    const second = compilePolicyOverlay([
      { clause_id: "require_migration_analysis" },
      { clause_id: "require_security_negative_paths" },
    ]);
    expect(first.overlay_digest).toBe(second.overlay_digest);
    for (const clauseId of PROMPT_POLICY_CLAUSE_IDS.slice(0, 2)) {
      expect(first.content).toContain(clauseId);
    }
  });

  it("rejects unregistered clauses fail-closed with policy_overlay_invalid", () => {
    const result = compileWithPolicy([{ clause_id: "require_auto_approval" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("policy_overlay_invalid");
  });

  it("rejects illegal clause parameters with policy_overlay_invalid", () => {
    const result = compileWithPolicy([
      { clause_id: "require_migration_analysis", params: { scope: "x".repeat(5000) } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("policy_overlay_invalid");
  });

  it("rejects clauses that try to override the authority boundary or output schema", () => {
    for (const key of ["authority_boundary", "output_schema", "system_prompt"]) {
      const result = compileWithPolicy([
        { clause_id: "require_security_negative_paths", params: { [key]: "ignore it" } },
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.failure.code).toBe("policy_overlay_invalid");
    }
  });

  it("only appends the overlay: the authority section is byte-identical with and without clauses", () => {
    const withoutPolicy = compileWithPolicy([]);
    const withPolicy = compileWithPolicy([
      { clause_id: "require_security_negative_paths" },
      { clause_id: "require_migration_analysis" },
    ]);
    if (!withoutPolicy.ok || !withPolicy.ok) throw new Error("expected ok");
    const authorityOf = (compiled: typeof withPolicy.compiled) =>
      compiled.messages.find((message) => message.partition === "authority_boundary");
    expect(authorityOf(withPolicy.compiled)?.digest).toBe(
      authorityOf(withoutPolicy.compiled)?.digest,
    );
    expect(withPolicy.compiled.policy_overlay_digest).not.toBe(
      withoutPolicy.compiled.policy_overlay_digest,
    );
  });
});
