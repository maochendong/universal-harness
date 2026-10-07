import { describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import {
  contentDigest,
  createPromptContractRegistry,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  RELATION_RULE_REGISTRY,
  IMPACT_ADVISORY_PROMPT_REGISTRATION,
  createInMemoryImpactAdvisoryPort,
  generateImpactSet,
  readImpactSetContent,
  type ImpactAdvisoryInput,
} from "@universal-harness-internal/graph";

import {
  createGenericInterpreter,
  createNewProject,
  resolveApproval,
  resumeIteration,
  runIteration,
  type OrchestratorDependencies,
} from "../../src/index.js";
import { adviseImpactSet } from "../../src/orchestration/contributors/impact-contributor.js";
import { PromptPreparationFailureError } from "../../src/model/capture-adapters.js";
import { ManagedRunnerError } from "../../src/model/managed-runner.js";
import { createModelBackedImpactAdvisoryPort } from "../../src/model/impact-advisory-adapter.js";
import { readModelInvocationRecords } from "../../src/model/invocation-store.js";
import {
  FIXED_NOW,
  cleanupDirectories,
  headOf,
  makeTempDir,
  sequentialIds,
} from "../bootstrap/helpers.js";

const PIPELINE_INTENT = "Ship a CSV export for the monthly report.";

/**
 * PG-3 contributor wiring: the optional advisory runs between propagation and
 * approval. Enabled advisory failures and clarification block the phase;
 * neither may silently fall back to approving the deterministic set.
 */
function makeNode(id: string, type: NodeRecord["type"]): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id,
    type,
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "contributor-test",
      timestamp: "2026-08-20T00:00:00Z",
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

const NODES = [
  makeNode("requirement_01", "Requirement"),
  makeNode("code-artifact_02", "CodeArtifact"),
];
const NODE_DIGEST = new Map(NODES.map((node) => [node.id, node.digest]));

const IDS = {
  workflow_operation_id: "operation_01K1ABC",
  iteration_id: "iteration_01K1ABC",
  attempt_id: "attempt_01",
};

function deterministicSet(): NodeRecord {
  return generateImpactSet(
    [
      {
        id: "seed_01",
        nodeId: "requirement_01",
        kind: "content-change",
        iterationKind: "feature",
        reason: "baseline intent drives the iteration",
      },
    ],
    NODES,
    [],
    { iterationId: "iteration_01", actor: "workflow-engine", timestamp: "2026-08-20T00:00:00Z" },
  );
}

describe("impact contributor advisory wiring", () => {
  it("retains candidate exclusion counts and reasons before whole-set approval", async () => {
    const set = deterministicSet();
    const diagnostic = {
      code: "candidate_scope" as const,
      candidate_count: 1,
      excluded_count: 1,
      excluded_by_reason: { already_deterministic: 1, not_accepted: 0, unsupported_type: 0 },
    };
    let observed: unknown;
    await expect(
      adviseImpactSet(
        IDS,
        set,
        NODES,
        {
          name: "scope-advisor",
          advise: async () => ({
            status: "proposed",
            additions: [],
            edge_candidates: [],
            risk_signals: [],
            missing_facts: [],
            questions: [],
            local_diagnostic: diagnostic,
          }),
        },
        (value) => {
          observed = value;
        },
      ),
    ).resolves.toEqual(set);
    expect(observed).toEqual(diagnostic);
  });

  it.each([0, 2, -1])("rejects inconsistent local scope counts: %s", async (candidateCount) => {
    await expect(
      adviseImpactSet(IDS, deterministicSet(), NODES, {
        name: "invalid-scope-advisor",
        advise: async () => ({
          status: "proposed",
          additions: [],
          edge_candidates: [],
          risk_signals: [],
          missing_facts: [],
          questions: [],
          local_diagnostic: {
            code: "candidate_scope",
            candidate_count: candidateCount,
            excluded_count: 1,
            excluded_by_reason: { already_deterministic: 1, not_accepted: 0, unsupported_type: 0 },
          },
        }),
      }),
    ).rejects.toMatchObject({ reason: "missing_input" });
  });

  it("gives each explicit attempt an independent conversation for the existing managed adapter", async () => {
    const projectRoot = makeTempDir("harness-impact-conversation-");
    try {
      const set = deterministicSet();
      const port = createModelBackedImpactAdvisoryPort({
        projectRoot,
        registry: createPromptContractRegistry([IMPACT_ADVISORY_PROMPT_REGISTRATION]),
        profile_id: "standard",
        provider_config: {
          provider_identity: "provider_fixture",
          config_digest: "c".repeat(64),
          budget_profile: "managed-standard",
        },
        provider: {
          invoke: async () => ({
            ok: true,
            content: JSON.stringify({
              purpose: "impact_advisory",
              schema_version: "impact-advisory.v1",
              impact_set_digest: readImpactSetContent(set).content_digest,
              additions: [],
              edge_candidates: [],
              risk_signals: [],
              missing_facts: [],
              questions: [],
            }),
          }),
        },
      });
      await adviseImpactSet(IDS, set, NODES, port);
      await expect(
        adviseImpactSet({ ...IDS, attempt_id: "attempt_02" }, set, NODES, port),
      ).resolves.toEqual(set);
      const consumed = readModelInvocationRecords(projectRoot).filter(
        (record) => record.state === "consumed",
      );
      expect(consumed).toHaveLength(2);
      expect(new Set(consumed.map((record) => record.conversation_id)).size).toBe(2);
      expect(new Set(consumed.map((record) => record.run_id)).size).toBe(2);
    } finally {
      cleanupDirectories();
    }
  });
  it("binds the deterministic set, graph and rule registry into the advisory input", async () => {
    const set = deterministicSet();
    let seen: ImpactAdvisoryInput | undefined;
    const port = createInMemoryImpactAdvisoryPort((input) => {
      seen = input;
      return {
        additions: [],
        edge_candidates: [],
        risk_signals: [],
        missing_facts: [],
        questions: [],
      };
    });
    await adviseImpactSet(IDS, set, NODES, port);
    expect(seen).toBeDefined();
    expect(seen!.impact_set_digest).toBe(readImpactSetContent(set).content_digest);
    expect(seen!.deterministic_entries).toEqual(readImpactSetContent(set).entries);
    expect(seen!.rule_registry_version).toBe(RELATION_RULE_REGISTRY.version);
    expect(seen!.rule_registry_digest).toBe(RELATION_RULE_REGISTRY.digest);
    expect(seen!.requirement_digests["requirement_01"]).toBe(NODE_DIGEST.get("requirement_01"));
    expect(seen!.conversation_id).toContain("impact-advisory-conversation_");
  });

  it("folds a clean advisory into the set that approval binds to", async () => {
    const set = deterministicSet();
    const port = createInMemoryImpactAdvisoryPort(() => ({
      additions: [
        {
          node_id: "code-artifact_02",
          node_type: "CodeArtifact",
          classification: "inspect",
          risk: "medium",
          confidence: 0.6,
          reason: "shares the export path",
          source_refs: [
            {
              kind: "graph_node",
              ref: "code-artifact_02",
              digest: NODE_DIGEST.get("code-artifact_02")!,
            },
          ],
        },
      ],
      edge_candidates: [],
      risk_signals: [],
      missing_facts: [],
      questions: [],
    }));
    const merged = await adviseImpactSet(IDS, set, NODES, port);
    const content = readImpactSetContent(merged);
    expect(content.content_digest).not.toBe(readImpactSetContent(set).content_digest);
    expect(content.entries.find((entry) => entry.node_id === "code-artifact_02")).toMatchObject({
      classification: "inspect",
      seed_id: "advisory",
    });
    expect(merged.status).toBe("proposed");
  });

  it("blocks instead of approving the deterministic set when an enabled advisory fails", async () => {
    const set = deterministicSet();
    const port = createInMemoryImpactAdvisoryPort(() => ({
      additions: [
        {
          node_id: "requirement_01",
          node_type: "Requirement",
          classification: "informational",
          risk: "low",
          confidence: 0.9,
          reason: "rewrite the deterministic entry",
          source_refs: [
            {
              kind: "graph_node",
              ref: "requirement_01",
              digest: NODE_DIGEST.get("requirement_01")!,
            },
          ],
        },
      ],
      edge_candidates: [],
      risk_signals: [],
      missing_facts: [],
      questions: [],
    }));
    await expect(adviseImpactSet(IDS, set, NODES, port)).rejects.toMatchObject({
      reason: "missing_input",
    });
  });

  it("blocks a clarification-only advisory before approval", async () => {
    const set = deterministicSet();
    const port = createInMemoryImpactAdvisoryPort(() => ({
      additions: [],
      edge_candidates: [],
      risk_signals: [],
      missing_facts: [],
      questions: [{ question: "does the export path include the audit log?" }],
    }));
    await expect(adviseImpactSet(IDS, set, NODES, port)).rejects.toMatchObject({
      reason: "missing_input",
    });
  });

  it.each([
    ["uncertain", false, "uncertain_external_action"],
    ["budget_exhausted", false, "budget_ceiling"],
    ["timeout", true, "transient_environment_failure"],
    ["provider_unavailable", true, "transient_environment_failure"],
    ["invalid_output", false, "missing_input"],
  ] as const)(
    "maps %s into a recoverable blocker without exposing provider text",
    async (code, retryable, reason) => {
      await expect(
        adviseImpactSet(IDS, deterministicSet(), NODES, {
          name: "failed-fixture",
          advise: async () => ({
            status: "failed",
            failure: { code, retryable, summary: "secret-provider-body" },
          }),
        }),
      ).rejects.toMatchObject({
        reason,
        message: expect.not.stringContaining("secret-provider-body"),
      });
    },
  );

  it("does not swallow unexpected adapter defects", async () => {
    const defect = new TypeError("unexpected adapter defect");
    await expect(
      adviseImpactSet(IDS, deterministicSet(), NODES, {
        name: "broken-fixture",
        advise: async () => {
          throw defect;
        },
      }),
    ).rejects.toBe(defect);
  });

  it.each([
    [
      new PromptPreparationFailureError({
        code: "prompt_size_exceeded",
        summary: "too large",
        retryable: false,
      }),
      "budget_ceiling",
    ],
    [new ManagedRunnerError("identity_conflict", "conflict"), "missing_input"],
  ] as const)("blocks a known preparation or identity failure", async (failure, reason) => {
    await expect(
      adviseImpactSet(IDS, deterministicSet(), NODES, {
        name: "known-failure-fixture",
        advise: async () => {
          throw failure;
        },
      }),
    ).rejects.toMatchObject({ reason });
  });

  it.each(["missing_facts", "questions"] as const)(
    "blocks proposed additions with unresolved %s",
    async (field) => {
      await expect(
        adviseImpactSet(IDS, deterministicSet(), NODES, {
          name: "incomplete-fixture",
          advise: async () => ({
            status: "proposed",
            additions: [],
            edge_candidates: [],
            risk_signals: [],
            missing_facts:
              field === "missing_facts"
                ? [
                    {
                      subject_id: "requirement_01",
                      fact: "missing contract",
                      why_it_matters: "cannot judge",
                      source_refs: [
                        { kind: "graph_node", ref: "requirement_01", digest: NODES[0]!.digest },
                      ],
                    },
                  ]
                : [],
            questions:
              field === "questions"
                ? [{ question: `secret at ${["", "Users", "fixture-user", "private"].join("/")}` }]
                : [],
          }),
        }),
      ).rejects.toMatchObject({ reason: "missing_input" });
    },
  );
});

/**
 * T20 slice 2: OrchestratorDependencies.impactAdvisory must reach the impact
 * phase through the profile module assembly — the facade forwards it at both
 * the run and the resume composition points.
 */
describe("orchestrator impact advisory forwarding", { timeout: 90000 }, () => {
  it("invokes the injected advisory during the impact phase of a real pipeline", async () => {
    const newId = sequentialIds();
    const created = await createNewProject(
      {
        parentDirectory: makeTempDir("harness-impact-pipe-"),
        name: "advisory-loop",
        intent: PIPELINE_INTENT,
      },
      { vcs: createGitVcsAdapter(), now: () => FIXED_NOW, newId },
    );
    if (!created.ok) throw new Error(created.error.message);
    const projectRoot = created.value.projectRoot;
    let seen: ImpactAdvisoryInput | undefined;
    const deps: OrchestratorDependencies = {
      projectRoot,
      readBaseline: () => headOf(projectRoot),
      now: () => FIXED_NOW,
      newId,
      vcs: createGitVcsAdapter(),
      interpret: createGenericInterpreter(),
      impactAdvisory: createInMemoryImpactAdvisoryPort((input) => {
        seen = input;
        return {
          additions: [],
          edge_candidates: [],
          risk_signals: [],
          missing_facts: [],
          questions: [],
        };
      }),
    };
    try {
      const first = await runIteration(deps, {
        intent: PIPELINE_INTENT,
        intentShape: "pack-converted",
      });
      if (first.status !== "approval_required") {
        throw new Error(`expected baseline approval, got ${first.status}`);
      }
      // The capture baseline approval pauses before the impact phase runs.
      expect(seen).toBeUndefined();
      await resolveApproval(deps, {
        requestId: first.required.request_id,
        decision: "approve",
        actor: "human:reviewer",
      });
      const second = await resumeIteration(deps, first.required.workflow_operation_id, undefined);
      // The advisory ran between propagation and the ImpactSet freeze approval.
      expect(second.status).toBe("approval_required");
      expect(seen).toBeDefined();
      expect(seen!.workflow_operation_id).toBe(first.required.workflow_operation_id);
      expect(seen!.deterministic_entries.length).toBeGreaterThan(0);
    } finally {
      cleanupDirectories();
    }
  });
});
