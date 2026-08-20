import { describe, expect, it, vi } from "vitest";

import {
  PROMPT_MESSAGE_PARTITIONS,
  compilePrompt,
  compilePromptForSlot,
  type CompiledPrompt,
} from "../../src/model/prompt-compiler.js";
import {
  TEST_PROMPT_PORT_ID,
  TEST_PROMPT_VERSION,
  createTestRegistry,
  testInputBundle,
} from "./fixtures.js";

function compileOk(profile: "lite" | "standard" | "governed" = "standard"): CompiledPrompt {
  const result = compilePrompt({
    registry: createTestRegistry(),
    selector: { port_id: TEST_PROMPT_PORT_ID, prompt_version: TEST_PROMPT_VERSION },
    profile,
    input_bundle: testInputBundle(),
  });
  if (!result.ok) throw new Error(`expected ok, got ${result.failure.code}`);
  return result.compiled;
}

describe("prompt compiler fixed order", () => {
  it("compiles exactly the seven protocol partitions in the fixed order", () => {
    const compiled = compileOk();
    expect(compiled.messages.map((message) => message.partition)).toEqual([
      ...PROMPT_MESSAGE_PARTITIONS,
    ]);
    expect(compiled.messages.map((message) => message.partition)).toEqual([
      "authority_boundary",
      "role_instruction",
      "domain_rubric",
      "profile_overlay",
      "policy_overlay",
      "output_contract",
      "untrusted_input",
    ]);
    // Only the untrusted bundle may ever occupy the user turn.
    expect(compiled.messages.slice(0, -1).every((message) => message.role === "system")).toBe(true);
    expect(compiled.messages.at(-1)?.role).toBe("user");
  });
});

describe("prompt compiler determinism", () => {
  it("produces the same compiled_prompt_digest for canonically equal input", () => {
    expect(compileOk().compiled_prompt_digest).toBe(compileOk().compiled_prompt_digest);
  });

  it("does not change any digest when bundle items arrive in a different order", () => {
    const bundle = testInputBundle();
    const shuffled = { ...bundle, items: [...bundle.items].reverse() };
    const result = compilePrompt({
      registry: createTestRegistry(),
      selector: { port_id: TEST_PROMPT_PORT_ID, prompt_version: TEST_PROMPT_VERSION },
      profile: "standard",
      input_bundle: shuffled,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.compiled.input_bundle_digest).toBe(compileOk().input_bundle_digest);
    expect(result.compiled.compiled_prompt_digest).toBe(compileOk().compiled_prompt_digest);
  });

  it("changes the compiled digest on any semantic change", () => {
    const bundle = testInputBundle();
    const changed = {
      ...bundle,
      items: [{ ...bundle.items[0]!, text: "# Demo\nA different project." }, bundle.items[1]!],
    };
    const result = compilePrompt({
      registry: createTestRegistry(),
      selector: { port_id: TEST_PROMPT_PORT_ID, prompt_version: TEST_PROMPT_VERSION },
      profile: "standard",
      input_bundle: changed,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.compiled.input_bundle_digest).not.toBe(compileOk().input_bundle_digest);
    expect(result.compiled.compiled_prompt_digest).not.toBe(compileOk().compiled_prompt_digest);
  });
});

describe("prompt compiler profile tiers", () => {
  it("only deepens the rubric across Lite/Standard/Governed; authority and output schema stay identical", () => {
    const lite = compileOk("lite");
    const standard = compileOk("standard");
    const governed = compileOk("governed");

    const authorityDigest = (compiled: CompiledPrompt) =>
      compiled.messages.find((message) => message.partition === "authority_boundary")?.digest;
    expect(authorityDigest(lite)).toBe(authorityDigest(standard));
    expect(authorityDigest(standard)).toBe(authorityDigest(governed));

    expect(lite.output_schema_digest).toBe(standard.output_schema_digest);
    expect(standard.output_schema_digest).toBe(governed.output_schema_digest);

    expect(lite.profile_overlay_digest).not.toBe(standard.profile_overlay_digest);
    expect(standard.profile_overlay_digest).not.toBe(governed.profile_overlay_digest);
    expect(lite.compiled_prompt_digest).not.toBe(governed.compiled_prompt_digest);
  });
});

describe("prompt compiler preparation failures", () => {
  it("returns a typed prompt_contract_version_mismatch failure for unknown selectors", () => {
    const result = compilePrompt({
      registry: createTestRegistry(),
      selector: { port_id: TEST_PROMPT_PORT_ID, prompt_version: "test-port.v99" },
      profile: "standard",
      input_bundle: testInputBundle(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("prompt_contract_version_mismatch");
    // A preparation failure payload never carries raw prompt text.
    expect(JSON.stringify(result.failure)).not.toContain(testInputBundle().items[0]!.text);
  });

  it("never invokes the compiler for a disabled Lite slot", () => {
    const compile = vi.fn(() => {
      throw new Error("compiler must not run for a disabled slot");
    });
    const result = compilePromptForSlot({ enabled: false }, compile);
    expect(compile).not.toHaveBeenCalled();
    expect(result.status).toBe("slot_disabled");
  });
});
