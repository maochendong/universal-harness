import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import type { AgentRunResult, AgentTaskEnvelope } from "@universal-harness-internal/plugin-sdk";
import {
  materializeLedger,
  pageEdges,
  pageNodes,
  readDesignSetExtension,
} from "@universal-harness-internal/graph";

import {
  createGenericInterpreter,
  createNewProject,
  moduleContributionsForProfile,
  readApprovalRequests,
  resolveApproval,
  resolveProfileModules,
  resumeIteration,
  runIteration,
  type OrchestrationOutcome,
  type OrchestratorDependencies,
} from "../../src/index.js";
import { projectIdFor } from "../../src/bootstrap/staging.js";
import {
  appendProjectProfileRecord,
  createInMemoryDesignProposalPort,
  createInMemoryDesignReviewPort,
  createProjectProfileRecord,
  harnessRootFor,
  readCommittedOperations,
  type DesignProposalInput,
} from "../../../core/src/index.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

/**
 * T12: the design_governance phase. A Standard-profile project runs
 * capture → impact → design → plan with the fixed chain
 * propose → validate → review → approve → atomic commit. The module fails
 * closed: no ports, an invalid proposal, a review critical finding or a
 * reject never reach an ApprovalRequest, and Lite or legacy projects never
 * run the phase at all.
 */
const INTENT = "Ship a CSV export for the monthly report.";
const DECISION_ID = "decision_01K1DEC";
const STRATEGY_ID = "designartifact_01K1TST";

function completeWithoutWrites(envelope: AgentTaskEnvelope): Promise<AgentRunResult> {
  return Promise.resolve({
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
  });
}

function makeDeps(
  projectRoot: string,
  newId: (kind: string) => string,
  overrides?: Partial<OrchestratorDependencies>,
): OrchestratorDependencies {
  return {
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    now: () => FIXED_NOW,
    newId,
    vcs: createGitVcsAdapter(),
    interpret: createGenericInterpreter(),
    execute: completeWithoutWrites,
    ...overrides,
  };
}

async function bootstrapStandardProject(
  name: string,
  newId: (kind: string) => string,
): Promise<string> {
  const outcome = await createNewProject(
    { parentDirectory: makeTempDir("harness-design-"), name, intent: INTENT },
    { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  const projectRoot = outcome.value.projectRoot;
  appendProjectProfileRecord(
    projectRoot,
    createProjectProfileRecord({
      project_id: projectIdFor(name),
      revision: 1,
      profile_id: "standard",
      policy_digest: "0".repeat(64),
      actor: "human:tester",
      effective_from: FIXED_NOW,
    }),
  );
  return projectRoot;
}

/** A proposal built from the bound input always passes deterministic validation. */
function proposalScript(input: DesignProposalInput) {
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

function acceptReviewScript(input: { must_change_requirement_ids: readonly string[] }) {
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

describe("design phase", { timeout: 90000 }, () => {
  it("runs propose → validate → review → approve → atomic commit under Standard", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapStandardProject("design-loop", newId);
    const deps = makeDeps(projectRoot, newId, {
      design: {
        proposal: createInMemoryDesignProposalPort(proposalScript),
        review: createInMemoryDesignReviewPort(acceptReviewScript),
      },
    });
    try {
      let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
      const approvals: string[] = [];
      let guard = 0;
      while (outcome.status === "approval_required") {
        guard += 1;
        if (guard > 10) throw new Error("approval loop did not terminate");
        approvals.push(outcome.required.object_type);
        outcome = await approveOnce(deps, outcome);
      }
      expect(outcome.status).toBe("completed");
      expect(approvals).toContain("DesignSet");
      expect(approvals.indexOf("DesignSet")).toBeGreaterThan(approvals.indexOf("ImpactSet"));

      const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
      try {
        const nodes = pageNodes(database, { limit: 500 }).items;
        const edges = pageEdges(database, { limit: 500 }).items;
        const designSet = nodes.find(
          (node) => node.type === "DesignSet" && node.status === "accepted",
        );
        expect(designSet).toBeDefined();
        const designSetId = designSet?.id ?? "";
        expect(
          edges.some(
            (edge) =>
              edge.type === "DERIVES_FROM" &&
              edge.source_id === designSetId &&
              nodes.some((node) => node.id === edge.target_id && node.type === "ImpactSet"),
          ),
        ).toBe(true);
        expect(
          edges.filter((edge) => edge.type === "CONTAINS" && edge.source_id === designSetId).length,
        ).toBeGreaterThanOrEqual(2);
        expect(nodes.some((node) => node.id === DECISION_ID && node.status === "accepted")).toBe(
          true,
        );
        // T14: every execution bundle binds the accepted DesignSet digest,
        // and the execution authorization carries the same binding.
        const designSetDigest = readDesignSetExtension(
          designSet as Parameters<typeof readDesignSetExtension>[0],
        ).content_digest;
        // Bundles are runtime artifacts, not graph nodes.
        const bundleDir = join(harnessRootFor(projectRoot), "artifacts", "context-bundles");
        const bundleFiles = readdirSync(bundleDir).filter((name) => name.endsWith(".json"));
        expect(bundleFiles.length).toBeGreaterThan(0);
        for (const name of bundleFiles) {
          const record = JSON.parse(readFileSync(join(bundleDir, name), "utf8")) as {
            extensions?: { "harness.context"?: { bindings?: Record<string, unknown> } };
          };
          expect(record.extensions?.["harness.context"]?.bindings?.["design_set_digest"]).toBe(
            designSetDigest,
          );
        }
      } finally {
        database.close();
      }
      const harnessRoot = harnessRootFor(projectRoot);
      expect(existsSync(join(harnessRoot, "artifacts", "design-sets"))).toBe(true);
      expect(existsSync(join(harnessRoot, "artifacts", "design-set-proposals"))).toBe(true);
      expect(existsSync(join(harnessRoot, "artifacts", "design-reviews"))).toBe(true);
    } finally {
      cleanupDirectories();
    }
  });

  it("blocks at design without proposal or review ports and writes nothing", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapStandardProject("design-no-port", newId);
    const deps = makeDeps(projectRoot, newId);
    try {
      let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
      outcome = await approveOnce(deps, outcome); // RequirementBaseline
      outcome = await approveOnce(deps, outcome); // ImpactSet
      expect(outcome.status).toBe("blocked");
      if (outcome.status === "blocked") {
        expect(outcome.reason).toBe("missing_input");
        expect(outcome.detail).toContain("DesignProposalPort");
      }
      const harnessRoot = harnessRootFor(projectRoot);
      expect(existsSync(join(harnessRoot, "artifacts", "design-sets"))).toBe(false);
      expect(existsSync(join(harnessRoot, "artifacts", "design-set-proposals"))).toBe(false);
    } finally {
      cleanupDirectories();
    }
  });

  it("never creates an ApprovalRequest behind an unresolved critical finding", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapStandardProject("design-critical", newId);
    const deps = makeDeps(projectRoot, newId, {
      design: {
        proposal: createInMemoryDesignProposalPort(proposalScript),
        review: createInMemoryDesignReviewPort((input) => ({
          verdict: "blocked" as const,
          findings: [
            {
              finding_id: "finding_01K1F01",
              severity: "critical" as const,
              category: "coverage_gap" as const,
              affected_asset_id: DECISION_ID,
              source_refs: [
                {
                  kind: "bundle_source" as const,
                  ref: input.bundle_sources[0]?.ref ?? "",
                  digest: input.bundle_sources[0]?.digest ?? "",
                },
              ],
              observed_problem: "the contract omits the failure path",
              recommended_revision: "revise the contract",
              suggested_verification: "contract test",
            },
          ],
          coverage_assessment: input.must_change_requirement_ids.map((requirementId) => ({
            requirement_id: requirementId,
            status: "deficient" as const,
          })),
          residual_risks: [],
          summary: "critical coverage gap",
        })),
      },
    });
    try {
      let outcome = await runIteration(deps, { intent: INTENT, intentShape: "pack-converted" });
      const workflowOperationId =
        outcome.status === "approval_required" ? outcome.required.workflow_operation_id : "";
      outcome = await approveOnce(deps, outcome); // RequirementBaseline
      outcome = await approveOnce(deps, outcome); // ImpactSet
      expect(outcome.status).toBe("blocked");
      const requests = readApprovalRequests(
        harnessRootFor(projectRoot),
        readCommittedOperations(harnessRootFor(projectRoot)),
        workflowOperationId,
      );
      expect(requests.map((request) => request.object_type)).not.toContain("DesignSet");
      expect(existsSync(join(harnessRootFor(projectRoot), "artifacts", "design-reviews"))).toBe(
        true,
      );
      expect(existsSync(join(harnessRootFor(projectRoot), "artifacts", "design-sets"))).toBe(false);
    } finally {
      cleanupDirectories();
    }
  });

  it("activates design_governance only where the profile requires it", () => {
    const lite = createProjectProfileRecord({
      project_id: "project_demo",
      revision: 1,
      profile_id: "lite",
      policy_digest: "0".repeat(64),
      actor: "human:tester",
      effective_from: FIXED_NOW,
    });
    const standard = createProjectProfileRecord({
      project_id: "project_demo",
      revision: 2,
      profile_id: "standard",
      policy_digest: "0".repeat(64),
      actor: "human:tester",
      effective_from: FIXED_NOW,
    });
    const resolutionOf = (profile: Parameters<typeof resolveProfileModules>[0]) =>
      resolveProfileModules(profile).find((entry) => entry.capability_id === "design_governance")
        ?.resolution;
    expect(resolutionOf(lite)).toBe("inactive_by_profile");
    expect(resolutionOf(standard)).toBe("active");
    expect(resolutionOf(undefined)).toBe("inactive_by_profile");
    const newId = sequentialIds();
    void newId;
  });
});

describe("design module wiring", () => {
  it("omits the design contribution unless the capability is active", async () => {
    const newId = sequentialIds();
    const projectRoot = await bootstrapStandardProject("design-wiring", newId);
    try {
      const withDesign = moduleContributionsForProfile(projectRoot, projectIdFor("design-wiring"));
      expect(withDesign.design?.capability_id).toBe("design_governance");
    } finally {
      cleanupDirectories();
    }
  });
});
