import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCaptureSessionRecord,
  createProjectProfileRecord,
  readCaptureModelProviderBindings,
  type CaptureRiskPolicy,
  type PrdReviewRubric,
} from "@universal-harness-internal/core";

import {
  ManagedCaptureCoordinatorError,
  createManagedCaptureCoordinator,
  readProjectRuntimeConfig,
  type ManagedCaptureCoordinatorDeps,
} from "../src/index.js";

/**
 * Managed capture coordinator assembly: the factory commits the Capture-scope
 * bindings and composes the protocol-1.1 coordinator from the real domain
 * stage factories over model-backed ports. Projects without `model_providers`
 * get no coordinator; partial declarations throw; a conflicting committed
 * binding is drift. The end-to-end case drives one session to
 * `awaiting_approval` through a queued fake provider.
 */
const roots: string[] = [];

const CAPTURE_SLOTS = ["approval_brief", "prd_proposal", "prd_review", "project_discovery"];

const POLICY_DIGEST = "9".repeat(64);
const BASELINE_DIGEST = "1".repeat(64);
const PROFILE_DECISION_ID = "profile-decision_01K1CAPTURE";
const PROFILE_DECISION_DIGEST = "2".repeat(64);

const POLICY: CaptureRiskPolicy = {
  project_id: "project_demo",
  profile_id: "standard",
  allow_policy_auto_approval: false,
  policy_actor: "policy:capture-standard@1",
};

const RUBRIC: PrdReviewRubric = {
  rubric_id: "capture-review-rubric",
  dimensions: [
    { dimension_id: "clarity", prompt: "Is every requirement unambiguous?" },
    { dimension_id: "completeness", prompt: "Does the PRD cover the intent?" },
    { dimension_id: "testability", prompt: "Is every criterion observable?" },
  ],
  mandatory_dimension_ids: ["clarity", "completeness", "testability"],
};

function providerEntry(slots: readonly string[], model = "deepseek-v4-pro") {
  return {
    provider_id: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model,
    api_key_env: "DEEPSEEK_API_KEY",
    env_allowlist: ["DEEPSEEK_API_KEY"],
    timeout_ms: 60000,
    slots: [...slots],
  };
}

function projectWithConfig(config: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-capture-coordinator-")));
  roots.push(root);
  mkdirSync(join(root, ".harness"), { recursive: true });
  writeFileSync(join(root, ".harness", "runtime.json"), JSON.stringify(config), "utf8");
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function makeProfile() {
  return createProjectProfileRecord({
    project_id: "project_demo",
    revision: 1,
    profile_id: "standard",
    policy_digest: POLICY_DIGEST,
    actor: "human:local",
    effective_from: "2026-08-21T00:00:00.000Z",
  });
}

function depsFor(
  root: string,
  overrides: Partial<ManagedCaptureCoordinatorDeps> = {},
): ManagedCaptureCoordinatorDeps {
  return {
    projectRoot: root,
    runtimeConfig: readProjectRuntimeConfig(root),
    profile: makeProfile(),
    profile_decision_id: PROFILE_DECISION_ID,
    profile_decision_digest: PROFILE_DECISION_DIGEST,
    project_baseline_digest: BASELINE_DIGEST,
    policy: POLICY,
    rubric: RUBRIC,
    readBaseline: () => "0".repeat(64),
    environment: { DEEPSEEK_API_KEY: "sk-test" },
    ...overrides,
  };
}

describe("createManagedCaptureCoordinator", () => {
  it("returns undefined when the project declares no model_providers", () => {
    const root = projectWithConfig({ runtime_config_version: 2, gates: [] });
    expect(createManagedCaptureCoordinator(depsFor(root))).toBeUndefined();
    expect(readCaptureModelProviderBindings(root)).toEqual([]);
  });

  it("fails closed when a declared provider leaves a capture slot uncovered", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(["prd_proposal", "prd_review"])],
    });
    try {
      createManagedCaptureCoordinator(depsFor(root));
      expect.unreachable("expected a slot_unresolved failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedCaptureCoordinatorError);
      expect((error as ManagedCaptureCoordinatorError).code).toBe("slot_unresolved");
      expect((error as ManagedCaptureCoordinatorError).message).toContain("project_discovery");
      expect((error as ManagedCaptureCoordinatorError).message).toContain("approval_brief");
    }
    expect(readCaptureModelProviderBindings(root)).toEqual([]);
  });

  it("commits the Capture-scope bindings once and reuses them idempotently", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(CAPTURE_SLOTS)],
    });
    const first = createManagedCaptureCoordinator(depsFor(root));
    expect(first).toBeDefined();
    expect(first!.binding_committed).toBe(true);

    const committed = readCaptureModelProviderBindings(root);
    expect(committed).toHaveLength(1);
    const record = committed[0]!;
    expect(record.record_digest).toBe(first!.binding_record_digest);
    expect(record.profile_decision_digest).toBe(PROFILE_DECISION_DIGEST);
    expect(record.policy_digest).toBe(POLICY_DIGEST);
    expect(record.baseline_digest).toBe(BASELINE_DIGEST);
    expect(record.bindings.map((binding) => binding.purpose)).toEqual([
      "approval_brief",
      "project_discovery",
    ]);
    for (const binding of record.bindings) {
      expect(binding.slot_id).toBe("grounded_synthesis");
      expect(binding.provider_identity).toBe("provider_deepseek");
      expect(binding.required).toBe(true);
      expect(binding.failure_mode).toBe("block");
      expect(binding.prompt_contract_digest).toMatch(/^[a-f0-9]{64}$/u);
    }

    const second = createManagedCaptureCoordinator(depsFor(root));
    expect(second!.binding_committed).toBe(false);
    expect(second!.binding_record_digest).toBe(first!.binding_record_digest);
    expect(readCaptureModelProviderBindings(root)).toHaveLength(1);
  });

  it("fails closed when a different binding is already committed for the profile decision", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(CAPTURE_SLOTS)],
    });
    createManagedCaptureCoordinator(depsFor(root));
    writeFileSync(
      join(root, ".harness", "runtime.json"),
      JSON.stringify({
        runtime_config_version: 2,
        gates: [],
        model_providers: [providerEntry(CAPTURE_SLOTS, "deepseek-v5")],
      }),
      "utf8",
    );
    try {
      createManagedCaptureCoordinator(depsFor(root));
      expect.unreachable("expected a binding_drift failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedCaptureCoordinatorError);
      expect((error as ManagedCaptureCoordinatorError).code).toBe("binding_drift");
    }
  });

  it("drives a session to awaiting_approval through the assembled stages", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [providerEntry(CAPTURE_SLOTS)],
    });
    writeFileSync(join(root, "README.md"), "# Demo\nA demo reporting application.\n", "utf8");

    const profile = makeProfile();
    const sessionInput = {
      workflow_operation_id: "operation_01K1CAPTURE",
      iteration_id: "iteration_01K1CAPTURE",
      intent_text: "Let users export the monthly report as a CSV file.",
      project_profile_digest: profile.record_digest,
      profile_decision_digest: PROFILE_DECISION_DIGEST,
      capture_policy_digest: POLICY_DIGEST,
      project_baseline_digest: BASELINE_DIGEST,
    };
    // The session record is a deterministic function of the start command, so
    // the proposal draft can bind the exact intent digest up front.
    const session = createCaptureSessionRecord(sessionInput);
    const intentBinding = {
      source_kind: "intent",
      source_id: "intent",
      source_digest: session.intent_digest,
    };
    const proposalDraft = JSON.stringify({
      schema_version: "1.1.0",
      intent: { text: session.intent_text, digest: session.intent_digest },
      problem_statement: "Users cannot archive monthly reports outside the application.",
      goals: [
        {
          draft_key: "goal-1",
          lineage: { kind: "new" },
          proposed_source_bindings: [intentBinding],
          statement: "Users can export the monthly report as a CSV file.",
        },
      ],
      non_goals: [],
      actors: [],
      scenarios: [],
      requirements: [
        {
          draft_key: "req-1",
          lineage: { kind: "new" },
          proposed_source_bindings: [intentBinding],
          statement: "The user can export the monthly report as a CSV file.",
          priority: "must",
          change_kind: "must_change",
          scenario_ids: [],
          acceptance_criterion_ids: ["criterion-1"],
        },
      ],
      constraints: [],
      acceptance_criteria: [
        {
          draft_key: "criterion-1",
          lineage: { kind: "new" },
          proposed_source_bindings: [intentBinding],
          requirement_id: "req-1",
          precondition: "a monthly report exists for the user",
          action: "the user exports the report as CSV",
          observable_outcome: "a CSV file containing the report rows is produced",
          verification_intent: "compare the exported CSV rows with the report data",
          test_first_example:
            "given an existing report, exporting produces a CSV whose rows match the report",
          scenario_kind: "primary",
        },
      ],
      assumptions: [],
      dependencies: [],
      risks: [],
      open_questions: [],
      glossary: [],
      context_source_refs: [],
    });
    const reviewReport = JSON.stringify({
      verdict: "accept",
      dimensions: RUBRIC.dimensions.map((dimension) => ({
        dimension_id: dimension.dimension_id,
        status: "satisfied",
        notes: "ok",
      })),
      findings: [],
      suggested_questions: [],
    });

    // The brief must bind the exact approval bundle and cite a manifest entry
    // verbatim; both are only known once the bundle is compiled, so the fake
    // provider reads them out of the compiled prompt it receives.
    const seen: string[] = [];
    const fetchFake = (() => {
      let call = 0;
      const fixed = [proposalDraft, reviewReport];
      return ((_url: string, init?: { body?: unknown }) => {
        const body = String(init?.body ?? "");
        seen.push(body);
        const content = fixed[call] ?? briefOutputFrom(body);
        call += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
        );
      }) as typeof fetch;
    })();
    function briefOutputFrom(requestBody: string): string {
      // The compiled prompt is embedded as a JSON string inside the request
      // body; parse it back to raw text before reading the manifest.
      const parsed = JSON.parse(requestBody) as { messages?: { content?: unknown }[] };
      const promptText = (parsed.messages ?? [])
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        )
        .join("\n");
      const bundleDigest = /"bundle":"([a-f0-9]{64})"/u.exec(promptText)?.[1];
      const ref =
        /"bundle_sources":\[\{"locator":"([^"]+)","source_digest":"([a-f0-9]{64})"\}/u.exec(
          promptText,
        );
      if (bundleDigest === undefined || ref === null) {
        throw new Error("compiled brief prompt carries no bundle manifest");
      }
      const sourceRef = { locator: ref[1], source_digest: ref[2] };
      return JSON.stringify({
        purpose: "approval_brief",
        schema_version: "approval-brief.v1",
        bundle_digest: bundleDigest,
        changes: [{ summary: "新增月度报表 CSV 导出。", source_refs: [sourceRef] }],
        risks: [{ summary: "导出数据范围以审批对象为准。", source_refs: [sourceRef] }],
        tradeoffs: [],
        open_questions: [],
      });
    }

    const assembled = createManagedCaptureCoordinator(depsFor(root, { fetch: fetchFake }));
    expect(assembled).toBeDefined();
    const outcome = await assembled!.coordinator.advance({
      command: "start_capture",
      ...sessionInput,
    });
    expect(outcome.status).toBe("awaiting_approval");
    expect(seen).toHaveLength(3);
  });
});
