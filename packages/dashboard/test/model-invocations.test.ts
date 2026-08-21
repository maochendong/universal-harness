import { describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { appendModelInvocationRecord, createNewProject } from "@universal-harness-internal/runtime";

import { sealRecordEnvelope } from "../../core/src/index.js";
import { cleanupDirectories, makeTempDir } from "../../runtime/test/bootstrap/helpers.js";
import { createDashboardReadApi } from "../src/read-api.js";

/**
 * PG-8 model observability Read API: the endpoint returns the latest
 * revision per invocation with its Chinese presentation; raw prompts are
 * never part of the payload.
 */
const digest = (letter: string) => letter.repeat(64);

function invocationRecord(state: string, revision: number) {
  return sealRecordEnvelope({
    protocol_version: "1.1.0",
    record_kind: "model_invocation",
    invocation_id: "invocation_01K1IV1",
    conversation_id: "conversation_01K1CV1",
    run_id: "run_01K1RN1",
    attempt: 1,
    revision,
    port_id: "design_review",
    prompt_contract_id: "harness:prompt:design-review",
    prompt_contract_version: "1.0.0",
    prompt_contract_digest: digest("1"),
    output_schema_id: "design-review-output",
    output_schema_digest: digest("2"),
    profile_overlay_digest: digest("3"),
    policy_overlay_digest: digest("4"),
    input_bundle_digest: digest("5"),
    compiled_prompt_digest: digest("6"),
    provider_identity: "provider_anthropic",
    config_digest: digest("7"),
    budget_profile: "operation-standard",
    cache_key: digest("8"),
    state,
    ...(state === "failed"
      ? { failure: { code: "provider_unavailable", summary: "boom", retryable: true } }
      : {}),
  });
}

describe("model invocation read api", () => {
  it("serves the latest revision per invocation with Chinese presentations", async () => {
    const outcome = await createNewProject(
      {
        parentDirectory: makeTempDir("harness-dash-invocations-"),
        name: "dash-invocations",
        intent: "observe model invocations",
      },
      { vcs: createGitVcsAdapter() },
    );
    if (!outcome.ok) throw new Error(outcome.error.message);
    const projectRoot = outcome.value.projectRoot;
    try {
      appendModelInvocationRecord(projectRoot, invocationRecord("started", 1) as never);
      appendModelInvocationRecord(projectRoot, invocationRecord("consumed", 2) as never);

      const api = createDashboardReadApi(projectRoot);
      const page = api.modelInvocations({});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.state).toBe("consumed");
      expect(page.items[0]?.revision).toBe(2);
      const presentation = Object.values(page.presentations)[0];
      expect(presentation?.type_label_zh).toBe("设计评审");
      expect(presentation?.status_label_zh).toBe("已消费");
      expect(JSON.stringify(page)).not.toContain("prompt_text");
    } finally {
      cleanupDirectories();
    }
  });

  it("serves an empty page for a project without invocations", async () => {
    const outcome = await createNewProject(
      {
        parentDirectory: makeTempDir("harness-dash-empty-"),
        name: "dash-empty",
        intent: "nothing invoked yet",
      },
      { vcs: createGitVcsAdapter() },
    );
    if (!outcome.ok) throw new Error(outcome.error.message);
    try {
      const api = createDashboardReadApi(outcome.value.projectRoot);
      const page = api.modelInvocations({});
      expect(page.items).toEqual([]);
      expect(page.presentations).toEqual({});
    } finally {
      cleanupDirectories();
    }
  });
});
