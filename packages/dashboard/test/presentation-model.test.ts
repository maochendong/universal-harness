import { describe, expect, it } from "vitest";

import { presentCapabilityStatus, presentModelInvocation } from "../src/presentation.js";

/**
 * PG-8 model observability presentation: every invocation renders its
 * Chinese port/purpose label, contract version, schema, usage, state and —
 * on failure — a Chinese explanation with a recovery action; raw prompts
 * never appear. Capability cards show generic and domain status together.
 */
const digest = (letter: string) => letter.repeat(64);

function invocationRecord(overrides: Record<string, unknown> = {}) {
  return {
    invocation_id: "invocation_01K1IV1",
    conversation_id: "conversation_01K1CV1",
    run_id: "run_01K1RN1",
    attempt: 1,
    revision: 1,
    port_id: "design_review",
    purpose: undefined,
    prompt_contract_id: "harness:prompt:design-review",
    prompt_contract_version: "1.0.0",
    prompt_contract_digest: digest("1"),
    output_schema_id: "design-review-output",
    output_schema_digest: digest("2"),
    profile_overlay_digest: digest("3"),
    policy_overlay_digest: digest("4"),
    input_bundle_digest: digest("5"),
    compiled_prompt_digest: digest("6"),
    config_digest: digest("7"),
    cache_key: digest("8"),
    provider_identity: "provider_anthropic",
    budget_profile: "operation-standard",
    state: "consumed",
    record_digest: digest("9"),
    ...overrides,
  };
}

describe("presentModelInvocation", () => {
  it("renders the Chinese port label, contract, schema and state", () => {
    const presentation = presentModelInvocation(invocationRecord());
    expect(presentation.entity_id).toBe("invocation_01K1IV1");
    expect(presentation.type_label_zh).toBe("设计评审");
    expect(presentation.status_label_zh).toBe("已消费");
    expect(presentation.title_zh).toContain("设计评审");
    expect(presentation.binding_digest).toBe(digest("9"));
    expect(presentation.fallback).toBe(false);
    const badges = Object.fromEntries(
      presentation.badges.map((badge) => [badge.label_zh, badge.value]),
    );
    expect(badges["契约版本"]).toBe("1.0.0");
    expect(badges["输出 Schema"]).toBe("design-review-output");
  });

  it("renders grounded purposes and usage when present", () => {
    const presentation = presentModelInvocation(
      invocationRecord({
        port_id: "grounded_synthesis",
        purpose: "iteration_narrative",
        usage: { tokens: 1234, duration_ms: 4200 },
      }),
    );
    expect(presentation.type_label_zh).toBe("迭代叙事");
    const badges = Object.fromEntries(
      presentation.badges.map((badge) => [badge.label_zh, badge.value]),
    );
    expect(badges["用量"]).toContain("1234");
  });

  it("explains failures in Chinese with a recovery action and never leaks prompts", () => {
    const failed = presentModelInvocation(
      invocationRecord({
        state: "failed",
        failure: { code: "provider_unavailable", summary: "connection reset", retryable: true },
      }),
    );
    expect(failed.status_label_zh).toBe("已失败");
    const failureBadge = failed.badges.find((badge) => badge.label_zh === "失败原因");
    expect(failureBadge?.tone).toBe("critical");
    expect(failureBadge?.value).toContain("Provider 不可用");
    const remedy = failed.badges.find((badge) => badge.label_zh === "恢复动作");
    expect(remedy?.value).toContain("重试");
    expect(JSON.stringify(failed)).not.toContain("prompt_text");
    expect(JSON.stringify(failed)).not.toContain("connection reset");
  });

  it("marks unknown ports as fallback instead of guessing", () => {
    const presentation = presentModelInvocation(invocationRecord({ port_id: "mystery_port" }));
    expect(presentation.fallback).toBe(true);
    expect(presentation.type_label_zh).toContain("mystery_port");
  });
});

describe("presentCapabilityStatus", () => {
  it("presents generic and domain status together", () => {
    const presentation = presentCapabilityStatus({
      capability_id: "impact_analysis",
      resolution: "active",
      generic_status: "proven",
      domain_status: "impact_set_approved",
    });
    expect(presentation.type_label_zh).toBe("影响分析");
    expect(presentation.status_label_zh).toBe("已证明");
    const badges = Object.fromEntries(
      presentation.badges.map((badge) => [badge.label_zh, badge.value]),
    );
    expect(badges["领域状态"]).toBe("impact_set_approved");
  });

  it("presents an inactive capability as not enabled without implying proof", () => {
    const presentation = presentCapabilityStatus({
      capability_id: "strict_tdd",
      resolution: "inactive_by_profile",
      generic_status: "not_enabled_by_profile",
    });
    expect(presentation.status_label_zh).toBe("未启用");
    expect(presentation.type_label_zh).toBe("严格 TDD");
  });
});
