import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendProjectContextBundleInvalidationRecord,
  appendProjectContextBundleRecord,
  createProjectContextBundleInvalidationRecord,
  createProjectContextBundleRecord,
} from "../../src/context/index.js";
import { contentDigest } from "../../src/identity/digest.js";
import { createProfileDecisionRecord } from "../../src/profile/decisions.js";
import { createCaptureModelProviderBindingRecord } from "../../src/profile/records.js";
import { submitCaptureModelProviderBindings } from "../../src/profile/store.js";
import type { ProjectContextBundleRecord } from "../../src/schema/context.js";
import type { ModelProviderBinding } from "../../src/schema/profile.js";
import { GROUNDED_SYNTHESIS_SCHEMA_VERSIONS } from "../../src/schema/synthesis.js";
import type { ProjectDiscoveryOutput } from "../../src/schema/synthesis.js";
import { runProjectDiscovery } from "../../src/synthesis/discovery.js";
import { createInMemoryGroundedSynthesisAdapter } from "../../src/synthesis/in-memory.js";
import { discoveryRecommendationFromRecord } from "../../src/synthesis/recommendation.js";
import {
  createGroundedSynthesisRecord,
  deriveGroundedConversationId,
  deriveGroundedRunId,
} from "../../src/synthesis/records.js";
import { readGroundedSynthesisRecords } from "../../src/synthesis/store.js";
import type { GroundedSynthesisResult } from "../../src/synthesis/port.js";

const SESSION_ID = "capture-session_01K1ABCDEFGHIJKLMNO";
const PROJECT_ID = "project_demo-app";
const DIGEST_A = "a".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const TIMESTAMP = "2026-08-19T00:00:00.000Z";

const BUDGET = {
  max_files: 8,
  max_bytes_per_source: 4096,
  max_total_bytes: 16384,
  max_summary_chars: 1000,
} as const;

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-discovery-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function profileDecision() {
  return createProfileDecisionRecord({
    decision_kind: "project_profile_change",
    project_id: PROJECT_ID,
    actor: "human:reviewer",
    idempotency_key: `profile-decision:${PROJECT_ID}:1`,
    current_profile_id: "standard",
    decided_profile_id: "standard",
    policy_digest: DIGEST_A,
    decided_at: TIMESTAMP,
  });
}

function discoveryBinding(overrides: Partial<ModelProviderBinding> = {}): ModelProviderBinding {
  return {
    slot_id: "grounded_synthesis",
    purpose: "project_discovery",
    required: true,
    provider_identity: "provider_fake",
    config_digest: DIGEST_E,
    prompt_version: "discovery.v1",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery,
    budget_profile: "capture-standard",
    failure_mode: "block",
    ...overrides,
  };
}

/** Commit the Capture-scope binding before any discovery call (design 11.1). */
function commitDiscoveryBinding(
  root: string,
  overrides: {
    readonly binding?: Partial<ModelProviderBinding>;
    readonly baseline_digest?: string;
    readonly policy_digest?: string;
  } = {},
): string {
  const record = createCaptureModelProviderBindingRecord({
    project_id: PROJECT_ID,
    profile_decision_id: profileDecision().profile_decision_id,
    profile_decision_digest: profileDecision().record_digest,
    policy_digest: overrides.policy_digest ?? DIGEST_C,
    config_digest: DIGEST_E,
    baseline_digest: overrides.baseline_digest ?? DIGEST_D,
    bindings: [discoveryBinding(overrides.binding)],
  });
  submitCaptureModelProviderBindings(root, record);
  return record.record_digest;
}

function makeBundle(): ProjectContextBundleRecord {
  return createProjectContextBundleRecord({
    session_id: SESSION_ID,
    purpose: "proposal",
    project_baseline_digest: DIGEST_D,
    profile_digest: DIGEST_A,
    policy_digest: DIGEST_C,
    budget: BUDGET,
    sources: [
      {
        locator: "README.md",
        source_kind: "readme",
        source_digest: contentDigest("# Demo"),
        selection_reason: "matched default candidate for source kind readme",
        classification: "internal_project",
        summary: "# Demo",
        truncated: false,
      },
      {
        locator: "package.json",
        source_kind: "manifest",
        source_digest: contentDigest('{"name":"demo"}'),
        selection_reason: "matched default candidate for source kind manifest",
        classification: "internal_project",
        summary: '{"name":"demo"}',
        truncated: false,
      },
    ],
    exclusions: [],
  });
}

function discoveryOutput(bundle: ProjectContextBundleRecord): ProjectDiscoveryOutput {
  return {
    purpose: "project_discovery",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery,
    bundle_digest: bundle.record_digest,
    facts: [
      {
        fact: "这是一个 Node 服务项目",
        confidence: "high",
        source_refs: [{ locator: "package.json", source_digest: contentDigest('{"name":"demo"}') }],
      },
    ],
    capability_candidates: [
      {
        capability_id: "impact_analysis",
        rationale: "README 描述了跨组件订单流程",
        confidence: "medium",
        source_refs: [{ locator: "README.md", source_digest: contentDigest("# Demo") }],
      },
    ],
    gate_candidates: [],
  };
}

function adapterReturning(result: GroundedSynthesisResult) {
  return createInMemoryGroundedSynthesisAdapter(() => result);
}

function runDeps(root: string, port: ReturnType<typeof createInMemoryGroundedSynthesisAdapter>) {
  const bundle = makeBundle();
  appendProjectContextBundleRecord(root, bundle);
  return {
    projectRoot: root,
    port,
    bundle,
    profileDecisionDigest: profileDecision().record_digest,
    expectedProjectBaselineDigest: DIGEST_D,
    sessionId: SESSION_ID,
  } as const;
}

describe("runProjectDiscovery", () => {
  it("completes with a validated, persisted record and an advisory recommendation", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const bundle = makeBundle();
    const port = adapterReturning({ status: "completed", output: discoveryOutput(bundle) });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;

    expect(outcome.record.purpose).toBe("project_discovery");
    expect(outcome.record.binding_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcome.record.bundle_digest).toBe(bundle.record_digest);
    expect(readGroundedSynthesisRecords(root)).toHaveLength(1);

    // The consumption contract exposes only advisory candidates.
    expect(outcome.recommendation.kind).toBe("project_discovery_recommendation");
    expect(outcome.recommendation.advisory).toBe(true);
    expect(outcome.recommendation.capability_candidates).toHaveLength(1);
    expect(outcome.recommendation).not.toHaveProperty("capability_plan");
    expect(outcome.recommendation).not.toHaveProperty("graph");
    expect(outcome.recommendation).not.toHaveProperty("profile");

    // The compiled input carries only bundle data — no filesystem access.
    expect(port.invocations).toHaveLength(1);
    const input = port.invocations[0]!;
    expect(input.purpose).toBe("project_discovery");
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(".harness");
    expect(JSON.parse(serialized)).toEqual(input);
  });

  it("replays an identical invocation without calling the adapter again", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const bundle = makeBundle();
    const port = adapterReturning({ status: "completed", output: discoveryOutput(bundle) });
    const deps = runDeps(root, port);
    const first = await runProjectDiscovery(deps);
    const second = await runProjectDiscovery(deps);
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(port.invocations).toHaveLength(1);
    if (first.status === "completed" && second.status === "completed") {
      expect(second.record.record_digest).toBe(first.record.record_digest);
    }
  });

  it("blocks with provider_required when no Capture-scope binding is committed", async () => {
    const root = makeRoot();
    const port = adapterReturning({
      status: "failed",
      failure: { code: "uncertain", summary: "x", retryable: false },
    });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "provider_required" } });
    expect(port.invocations).toHaveLength(0);
  });

  it("blocks with binding_drift when the committed binding baseline drifted", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root, { baseline_digest: DIGEST_E });
    const bundle = makeBundle();
    const port = adapterReturning({ status: "completed", output: discoveryOutput(bundle) });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "binding_drift" } });
    expect(port.invocations).toHaveLength(0);
  });

  it("blocks with binding_drift when the committed binding policy drifted", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root, { policy_digest: DIGEST_A });
    const bundle = makeBundle();
    const port = adapterReturning({ status: "completed", output: discoveryOutput(bundle) });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "binding_drift" } });
  });

  it("blocks with version_mismatch when the binding pins another schema version", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root, { binding: { schema_version: "project-discovery.v0" } });
    const bundle = makeBundle();
    const port = adapterReturning({ status: "completed", output: discoveryOutput(bundle) });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "version_mismatch" } });
    expect(port.invocations).toHaveLength(0);
  });

  it("blocks with bundle_stale when the baseline moved after compilation", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const bundle = makeBundle();
    const port = adapterReturning({ status: "completed", output: discoveryOutput(bundle) });
    const deps = { ...runDeps(root, port), expectedProjectBaselineDigest: DIGEST_E };
    const outcome = await runProjectDiscovery(deps);
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "bundle_stale" } });
    expect(port.invocations).toHaveLength(0);
  });

  it("blocks with bundle_stale when an invalidation record was appended", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const bundle = makeBundle();
    appendProjectContextBundleRecord(root, bundle);
    appendProjectContextBundleInvalidationRecord(
      root,
      createProjectContextBundleInvalidationRecord({ bundle, reasons: ["baseline_drift"] }),
    );
    const port = adapterReturning({ status: "completed", output: discoveryOutput(bundle) });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "bundle_stale" } });
    expect(port.invocations).toHaveLength(0);
  });

  it("rejects outputs carrying a different purpose (cross-purpose cache reuse)", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const bundle = makeBundle();
    const foreign: GroundedSynthesisResult = {
      status: "completed",
      output: {
        purpose: "approval_brief",
        schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.approval_brief,
        bundle_digest: bundle.record_digest,
        changes: [],
        risks: [],
        tradeoffs: [],
        open_questions: [],
      },
    };
    const port = adapterReturning(foreign);
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "invalid_output" } });
    expect(readGroundedSynthesisRecords(root)).toHaveLength(0);
  });

  it("rejects outputs with a wrong schema version", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const bundle = makeBundle();
    const output = {
      ...discoveryOutput(bundle),
      schema_version: "project-discovery.v99",
    } as unknown as ProjectDiscoveryOutput;
    const port = adapterReturning({ status: "completed", output });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "invalid_output" } });
  });

  it("rejects claims citing sources outside the current bundle", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const bundle = makeBundle();
    const output: ProjectDiscoveryOutput = {
      ...discoveryOutput(bundle),
      facts: [
        {
          fact: "臆造事实",
          confidence: "high",
          source_refs: [{ locator: "docs/not-in-bundle.md", source_digest: DIGEST_A }],
        },
      ],
    };
    const port = adapterReturning({ status: "completed", output });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "citation_invalid" } });
    expect(readGroundedSynthesisRecords(root)).toHaveLength(0);
  });

  it("rejects claims whose source digest no longer matches the bundle", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const bundle = makeBundle();
    const output: ProjectDiscoveryOutput = {
      ...discoveryOutput(bundle),
      facts: [
        {
          fact: "过期引用",
          confidence: "high",
          source_refs: [{ locator: "README.md", source_digest: DIGEST_A }],
        },
      ],
    };
    const port = adapterReturning({ status: "completed", output });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "citation_invalid" } });
  });

  it("blocks with independence_violation when the conversation id was used by another purpose", async () => {
    const root = makeRoot();
    const bindingDigest = commitDiscoveryBinding(root);
    const bundle = makeBundle();
    // A foreign record squats on the conversation identity discovery derives.
    const conversation_id = deriveGroundedConversationId({
      purpose: "project_discovery",
      binding_digest: bindingDigest,
      bundle_digest: bundle.record_digest,
    });
    const squatting = createGroundedSynthesisRecord({
      purpose: "approval_brief",
      session_id: SESSION_ID,
      profile_decision_digest: profileDecision().record_digest,
      binding_digest: bindingDigest,
      bundle_digest: bundle.record_digest,
      conversation_id,
      run_id: deriveGroundedRunId({ conversation_id, input_digest: DIGEST_E }),
      input_digest: DIGEST_E,
      output: {
        purpose: "approval_brief",
        schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.approval_brief,
        bundle_digest: bundle.record_digest,
        changes: [],
        risks: [],
        tradeoffs: [],
        open_questions: [],
      },
    });
    const { appendGroundedSynthesisRecord } = await import("../../src/synthesis/store.js");
    appendGroundedSynthesisRecord(root, squatting);

    const port = adapterReturning({ status: "completed", output: discoveryOutput(bundle) });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({
      status: "blocked",
      failure: { code: "independence_violation" },
    });
    expect(port.invocations).toHaveLength(0);
  });

  it("propagates typed adapter failures without persisting anything", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const port = adapterReturning({
      status: "failed",
      failure: { code: "uncertain", summary: "provider 结果不明", retryable: true },
    });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "uncertain" } });
    expect(readGroundedSynthesisRecords(root)).toHaveLength(0);
  });
});

describe("discovery recommendation consumption contract", () => {
  it("rejects records of another purpose", () => {
    const bundle = makeBundle();
    const record = createGroundedSynthesisRecord({
      purpose: "approval_brief",
      session_id: SESSION_ID,
      profile_decision_digest: profileDecision().record_digest,
      binding_digest: "1".repeat(64),
      bundle_digest: bundle.record_digest,
      conversation_id: deriveGroundedConversationId({
        purpose: "approval_brief",
        binding_digest: "1".repeat(64),
        bundle_digest: bundle.record_digest,
      }),
      run_id: deriveGroundedRunId({
        conversation_id: deriveGroundedConversationId({
          purpose: "approval_brief",
          binding_digest: "1".repeat(64),
          bundle_digest: bundle.record_digest,
        }),
        input_digest: DIGEST_E,
      }),
      input_digest: DIGEST_E,
      output: {
        purpose: "approval_brief",
        schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.approval_brief,
        bundle_digest: bundle.record_digest,
        changes: [],
        risks: [],
        tradeoffs: [],
        open_questions: [],
      },
    });
    const result = discoveryRecommendationFromRecord(record, bundle);
    expect(result.status).toBe("rejected");
  });

  it("rejects records bound to a different bundle", async () => {
    const root = makeRoot();
    commitDiscoveryBinding(root);
    const bundle = makeBundle();
    const port = adapterReturning({ status: "completed", output: discoveryOutput(bundle) });
    const outcome = await runProjectDiscovery(runDeps(root, port));
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    const drifted = makeBundle();
    const other = createProjectContextBundleRecord({
      session_id: SESSION_ID,
      purpose: "review",
      project_baseline_digest: DIGEST_E,
      profile_digest: DIGEST_A,
      policy_digest: DIGEST_C,
      budget: BUDGET,
      sources: [],
      exclusions: [],
    });
    expect(discoveryRecommendationFromRecord(outcome.record, other).status).toBe("rejected");
    expect(drifted.record_digest).not.toBe(other.record_digest);
  });
});
