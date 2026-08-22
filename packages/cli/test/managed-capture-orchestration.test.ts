import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import type { AgentRunResult, AgentTaskEnvelope } from "@universal-harness-internal/plugin-sdk";
import {
  appendProjectProfileRecord,
  contentDigest,
  createInMemoryDesignProposalPort,
  createInMemoryDesignReviewPort,
  createProjectProfileRecord,
  harnessRootFor,
  intentDigestOf,
  readCommittedOperations,
  readLatestCaptureSession,
  readManagedManifest,
  type DesignProposalInput,
} from "@universal-harness-internal/core";
import {
  OrchestrationError,
  captureSessionIdFor,
  createGenericInterpreter,
  createNewProject,
  materializeProjectGraph,
  readApprovalRequests,
  resolveApproval,
  resumeIteration,
  runIteration,
  type EvaluationPort,
  type OrchestrationExecutor,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
} from "@universal-harness-internal/runtime";

import { managedCaptureSeamForProject } from "../src/runtime-service.js";
import { readProjectRuntimeConfig } from "../src/index.js";

/**
 * Protocol-1.1 slice 2 integration: a project with `model_providers` and a
 * committed profile record drives capture through the PrdCaptureCoordinator
 * (fake provider via fetch), bridges the human approval through the one
 * engine approval surface, and skips the legacy baseline commit entirely.
 * The gate-off branches keep returning undefined so legacy projects are
 * untouched.
 */
const roots: string[] = [];

const INTENT = "Ship a CSV export for the monthly report.";
const FIXED_NOW = "2026-08-21T00:00:00.000Z";
const CAPTURE_SLOTS = ["approval_brief", "prd_proposal", "prd_review", "project_discovery"];
const DECISION_ID = "decision_01K1DEC";
const STRATEGY_ID = "designartifact_01K1TST";

function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function headOf(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

/** Deterministic ids: `<kind>_t0001`, `<kind>_t0002`, ... per kind. */
function sequentialIds(): (kind: string) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_t${String(next).padStart(4, "0")}`;
  };
}

function providerEntry(slots: readonly string[]) {
  return {
    provider_id: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-pro",
    api_key_env: "DEEPSEEK_API_KEY",
    env_allowlist: ["DEEPSEEK_API_KEY"],
    timeout_ms: 60000,
    slots: [...slots],
  };
}

async function bootstrapProject(
  name: string,
  newId: (kind: string) => string,
  options: { readonly profile: boolean; readonly slots?: readonly string[] } = { profile: true },
): Promise<string> {
  const outcome = await createNewProject(
    { parentDirectory: makeTempDir("harness-capture-orch-"), name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  const projectRoot = outcome.value.projectRoot;
  if (options.profile) {
    appendProjectProfileRecord(
      projectRoot,
      createProjectProfileRecord({
        project_id: `project_${readManagedManifest(projectRoot).name}`,
        revision: 1,
        profile_id: "standard",
        policy_digest: "0".repeat(64),
        actor: "human:tester",
        effective_from: FIXED_NOW,
      }),
    );
  }
  writeFileSync(
    join(projectRoot, ".harness", "runtime.json"),
    JSON.stringify({
      runtime_config_version: 2,
      gates: [],
      ...(options.slots === undefined ? {} : { model_providers: [providerEntry(options.slots)] }),
    }),
    "utf8",
  );
  return projectRoot;
}

/** A design proposal built from the bound input always passes deterministic validation. */
function designProposalScript(input: DesignProposalInput) {
  const notApplicable = { status: "not_applicable", reason: "no surface change" } as const;
  return {
    proposal: {
      requirement_baseline_digest: input.requirement_baseline_digest,
      impact_set_id: input.impact_set_id,
      impact_set_digest: input.impact_set_digest,
      policy_digest: input.policy_digest,
      repository_baseline: input.repository_baseline,
      mode: "change" as const,
      node_changes: [
        {
          action: "create" as const,
          node_id: DECISION_ID,
          node_type: "Decision" as const,
          target_revision: 1,
          proposed_extensions: { "harness.decision": { summary: "cover the requirement" } },
        },
        {
          action: "create" as const,
          node_id: STRATEGY_ID,
          node_type: "DesignArtifact" as const,
          target_revision: 1,
          proposed_extensions: {
            "harness.design.artifact": {
              artifact_kind: "test_strategy",
              title: "strategy",
              summary: "strategy",
              assumptions: [],
              acceptance_implications: [],
              body_format: "structured",
              body: {
                scenarios: ["happy path"],
                test_levels: ["unit"],
                required_gates: [],
                required_evidence: [],
                tdd: input.must_change_requirement_ids.map((requirementId) => ({
                  requirement_id: requirementId,
                  applicability: {
                    status: "not_applicable",
                    category: "docs_only",
                    reason: "no behavioural change",
                  },
                })),
              },
            },
          },
        },
      ],
      reused_assets: [],
      edge_changes: [
        ...input.must_change_requirement_ids.map((requirementId, index) => ({
          action: "create" as const,
          edge_id: `edge_01K1A${String(index)}`,
          relation: "ADDRESSES" as const,
          source_id: DECISION_ID,
          target_id: requirementId,
        })),
        ...input.criterion_test_pairs.map((pair, index) => ({
          action: "create" as const,
          edge_id: `edge_01K1S${String(index)}`,
          relation: "SPECIFIES" as const,
          source_id: STRATEGY_ID,
          target_id: pair.test_node_id,
        })),
      ],
      coverage: input.must_change_requirement_ids.map((requirementId) => ({
        requirement_id: requirementId,
        decision_ids: [DECISION_ID],
        component_scope: { status: "not_applicable" as const, reason: "no component change" },
        test_strategy_coverage: input.criterion_test_pairs
          .filter((pair) => pair.requirement_id === requirementId)
          .map((pair) => ({
            acceptance_criterion_id: pair.acceptance_criterion_id,
            test_node_id: pair.test_node_id,
            primary_test_strategy_id: STRATEGY_ID,
          })),
        supporting_test_strategy_ids: [],
        applicability: { api: notApplicable, data: notApplicable, ui: notApplicable },
      })),
      risk_summary: { level: "high" as const, reasons: ["impact and contract floor"] },
      rationale: "cover every must-change requirement",
    },
    questions: [],
  };
}

function designAcceptReviewScript(input: { must_change_requirement_ids: readonly string[] }) {
  return {
    verdict: "accept_recommended" as const,
    findings: [],
    coverage_assessment: input.must_change_requirement_ids.map((requirementId) => ({
      requirement_id: requirementId,
      status: "covered" as const,
    })),
    residual_risks: [],
    summary: "coverage complete",
  };
}

function claimedResult(envelope: AgentTaskEnvelope): AgentRunResult {
  return {
    outcome: "handoff",
    termination_reason: "completion",
    completion_claimed: true,
    summary: `completed ${envelope.task_id}`,
    state_proposal: null,
    dropped_proposal_fields: [],
    change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
    tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
    usage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      duration_ms: 0,
      metering: "unmetered",
    },
    evidence: [
      { kind: "attestation", locator: `envelope://${envelope.task_id}`, digest: "a".repeat(64) },
    ],
    undeclared_writes: [],
  };
}

const TEST_AGENT_PROFILE = {
  provider: "test-agent",
  control: "delegated",
  trajectory_visibility: "external-only",
  usage_metering: false,
  side_effect_interception: false,
  resume_semantics: "none",
} as const;

const completeEvaluation: EvaluationPort = (input) => {
  const dimensions = (
    ["outcome", "safety", "trajectory", "correct_failure", "efficiency"] as const
  ).map((dimension) => ({
    dimension,
    available: true,
    score: 1,
    threshold: dimension === "efficiency" ? 0 : 1,
    passed: true,
    mandatory: dimension === "outcome" || dimension === "safety",
    deterministic: true,
    scorer: `deterministic/${dimension}`,
    reason: `${dimension} passed`,
    confidence: null,
  }));
  const extension = {
    case_id: `case_${input.taskId.slice("task_".length)}`,
    case_digest: "b".repeat(64),
    visibility: input.visibility,
    coverage: {
      visibility: input.visibility,
      available_fields: ["outcome", "termination_reason", "usage"],
      unavailable_fields: [
        "tool_activity_summary",
        "step_sequence",
        "tool_validity",
        "repeat_detection",
      ],
      ratio: 0.428571,
    },
    dimensions,
    mandatory_failures: [],
    passed: true,
    ...(input.adapterProfileDigest === undefined
      ? {}
      : { adapter_profile_digest: input.adapterProfileDigest }),
  };
  const record = {
    protocol_version: "1.0.0",
    record_kind: "evidence",
    evidence_id: `evidence_evaluation_${input.taskId.slice("task_".length)}`,
    evidence_type: "evaluation_report",
    subject_id: input.taskId,
    digest: contentDigest({
      evidence_type: "evaluation_report",
      subject_id: input.taskId,
      extension,
    }),
    provisional: false,
    created_at: input.now,
    extensions: { "harness.evaluation": extension },
  };
  return {
    evidenceId: record.evidence_id,
    passed: true,
    mandatoryFailures: [],
    findings: [],
    summary: "five-dimensional evaluation passed",
    record,
  };
};

/** The fake provider: proposal, then review, then the brief grounded in the compiled prompt. */
function captureFetch(seenBodies: string[]): typeof fetch {
  const intentDigest = intentDigestOf(INTENT);
  const intentBinding = {
    source_kind: "intent",
    source_id: "intent",
    source_digest: intentDigest,
  };
  const proposalDraft = JSON.stringify({
    schema_version: "1.1.0",
    intent: { text: INTENT, digest: intentDigest },
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
    dimensions: ["clarity", "completeness", "testability"].map((dimensionId) => ({
      dimension_id: dimensionId,
      status: "satisfied",
      notes: "ok",
    })),
    findings: [],
    suggested_questions: [],
  });
  const fixed = [proposalDraft, reviewReport];
  let call = 0;
  return ((_url: string, init?: { body?: unknown }) => {
    const body = String(init?.body ?? "");
    seenBodies.push(body);
    const content = fixed[call] ?? briefOutputFrom(body);
    call += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    );
  }) as typeof fetch;
}

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
  const ref = /"bundle_sources":\[\{"locator":"([^"]+)","source_digest":"([a-f0-9]{64})"\}/u.exec(
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

function approvalRequestsFor(projectRoot: string, workflowOperationId: string) {
  return readApprovalRequests(
    harnessRootFor(projectRoot),
    readCommittedOperations(harnessRootFor(projectRoot)),
    workflowOperationId,
  );
}

async function approveOnce(
  deps: OrchestratorDependencies,
  outcome: OrchestrationOutcome,
): Promise<OrchestrationOutcome> {
  if (outcome.status !== "approval_required") {
    throw new Error(`expected approval_required, got ${outcome.status}`);
  }
  await resolveApproval(deps, {
    requestId: outcome.required.request_id,
    decision: "approve",
    actor: "human:reviewer",
  });
  return resumeIteration(deps, outcome.required.workflow_operation_id, undefined);
}

describe("managed capture seam gating", () => {
  it("returns undefined without model_providers, even with a profile record", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("capture-gate-none", newId, { profile: true });
    expect(
      managedCaptureSeamForProject(projectRoot, readProjectRuntimeConfig(projectRoot)),
    ).toBeUndefined();
  });

  it("returns undefined for a pre-1.1 project without a profile record", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("capture-gate-legacy", newId, {
      profile: false,
      slots: CAPTURE_SLOTS,
    });
    expect(
      managedCaptureSeamForProject(projectRoot, readProjectRuntimeConfig(projectRoot)),
    ).toBeUndefined();
  });

  it("fails closed as a configuration error when a declared slot has no coverage", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("capture-gate-partial", newId, {
      profile: true,
      slots: ["prd_proposal"],
    });
    try {
      managedCaptureSeamForProject(projectRoot, readProjectRuntimeConfig(projectRoot));
      expect.unreachable("expected a configuration failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError);
      expect((error as OrchestrationError).kind).toBe("configuration");
    }
  });
});

describe("coordinated capture pipeline", { timeout: 90000 }, () => {
  it("drives a full iteration through the coordinator with one bridged approval surface", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapProject("capture-loop", newId, {
      profile: true,
      slots: CAPTURE_SLOTS,
    });
    const seenBodies: string[] = [];
    const seam = managedCaptureSeamForProject(projectRoot, readProjectRuntimeConfig(projectRoot), {
      fetch: captureFetch(seenBodies),
      environment: { DEEPSEEK_API_KEY: "sk-test" },
    });
    expect(seam).toBeDefined();

    let seenCriterionPairs: DesignProposalInput["criterion_test_pairs"] = [];
    const deps: OrchestratorDependencies = {
      projectRoot,
      readBaseline: () => headOf(projectRoot),
      now: () => FIXED_NOW,
      newId,
      vcs: createGitVcsAdapter(),
      interpret: createGenericInterpreter(),
      capture: seam,
      design: {
        proposal: createInMemoryDesignProposalPort((input) => {
          seenCriterionPairs = input.criterion_test_pairs;
          return designProposalScript(input);
        }),
        review: createInMemoryDesignReviewPort(designAcceptReviewScript),
      },
      execution: {
        kind: "agent",
        name: "test-agent",
        deterministic: false,
        adapter_profile: TEST_AGENT_PROFILE,
        execute: ((envelope: AgentTaskEnvelope) =>
          Promise.resolve(claimedResult(envelope))) as OrchestrationExecutor,
      },
      evaluate: completeEvaluation,
    };

    let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
    expect(outcome.status).toBe("approval_required");
    if (outcome.status !== "approval_required") return;
    expect(outcome.required.object_type).toBe("CapturePrdProposal");
    const captureRequest = outcome.required;

    // A resume without a decision reuses the pending request — no duplicate.
    const again = await resumeIteration(deps, captureRequest.workflow_operation_id, undefined);
    expect(again.status).toBe("approval_required");
    if (again.status !== "approval_required") return;
    expect(again.required.request_id).toBe(captureRequest.request_id);
    expect(approvalRequestsFor(projectRoot, captureRequest.workflow_operation_id)).toHaveLength(1);

    const approvals: string[] = [captureRequest.object_type];
    outcome = await approveOnce(deps, again);
    let guard = 0;
    while (outcome.status === "approval_required") {
      guard += 1;
      if (guard > 10) throw new Error("approval loop did not terminate");
      approvals.push(outcome.required.object_type);
      outcome = await approveOnce(deps, outcome);
    }
    expect(outcome.status).toBe("completed");
    expect(approvals).toEqual([
      "CapturePrdProposal",
      "ImpactSet",
      "DesignSet",
      "ExecutionAuthorizationSpec",
    ]);

    // Exactly three model calls: proposal, review, approval brief. The
    // resumes above added none — the coordinator replays committed facts.
    expect(seenBodies).toHaveLength(3);

    // The accepted transaction wrote the Test seeds with their criterion
    // bindings, and the design phase saw the compiled pairs.
    const graph = materializeProjectGraph(projectRoot);
    try {
      const seeds = graph.nodes.filter((node) => node.type === "Test");
      expect(seeds).toHaveLength(1);
      const extension = seeds[0]!.extensions?.["harness.requirements"] as Record<string, unknown>;
      expect(typeof extension["acceptance_criterion_id"]).toBe("string");
      expect(extension["criterion_semantic_digest"]).toMatch(/^[a-f0-9]{64}$/u);
      expect(typeof extension["verifies"]).toBe("string");
    } finally {
      graph.close();
    }
    expect(seenCriterionPairs.length).toBeGreaterThan(0);

    // The capture session is accepted and the legacy baseline document was
    // never written — the accepted transaction owns the baseline commit.
    const session = readLatestCaptureSession(projectRoot, captureSessionIdFor(INTENT));
    expect(session?.state).toBe("accepted");
    expect(
      existsSync(join(harnessRootFor(projectRoot), "artifacts", "requirement-baselines")),
    ).toBe(false);
  });
});
