import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerRepository,
  resolveHarnessPath,
  validateSchema,
} from "@universal-harness-internal/core";

import {
  WorkflowEngine,
  baselineDocumentArtifactPath,
  captureRequirements,
  commitRequirementBaseline,
  requirementBaselineDigest,
  type BaselineContext,
  type BaselineIdKind,
  type CaptureIdKind,
  type RequirementProposal,
} from "../../src/index.js";
import {
  BASELINE,
  FIXED_NOW,
  cleanupDirectories,
  makeDeps,
  makeProjectRoot,
  makeStartInput,
  phaseIds,
} from "../workflow/helpers.js";

afterEach(() => {
  cleanupDirectories();
});

function mint(prefix: string): (kind: CaptureIdKind | BaselineIdKind) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_${prefix}${String(next).padStart(2, "0")}`;
  };
}

function makeProposal(): RequirementProposal {
  const outcome = captureRequirements(
    {
      text: "add a health endpoint",
      requirements: [
        {
          statement: "the service exposes GET /health",
          acceptance: [{ description: "GET /health returns 200", verification: "gate:http-check" }],
        },
      ],
      constraints: [
        { statement: "no new runtime dependency", verification: "gate:dependency-scan" },
      ],
    },
    { newId: mint("c") },
  );
  if (outcome.status !== "captured") throw new Error("expected a captured proposal");
  return outcome.proposal;
}

function makeContext(overrides?: Partial<BaselineContext>): BaselineContext {
  return {
    projectId: "project_demo",
    iterationId: "iteration_t0001",
    actor: "user:alice",
    timestamp: FIXED_NOW,
    newId: mint("b"),
    ...overrides,
  };
}

describe("requirementBaselineDigest", () => {
  it("is stable and independent of provenance metadata", () => {
    const proposal = makeProposal();
    expect(requirementBaselineDigest(proposal)).toMatch(/^[a-f0-9]{64}$/u);
    expect(requirementBaselineDigest(proposal)).toBe(requirementBaselineDigest(makeProposal()));
  });

  it("changes when any requirement content changes", () => {
    const proposal = makeProposal();
    const changed: RequirementProposal = {
      ...proposal,
      requirements: proposal.requirements.map((requirement) => ({
        ...requirement,
        statement: `${requirement.statement} v2`,
      })),
    };
    expect(requirementBaselineDigest(changed)).not.toBe(requirementBaselineDigest(proposal));
  });
});

describe("commitRequirementBaseline", () => {
  it("commits nodes, traceability edges and the canonical document atomically", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("op") }));
    const started = await engine.startOperation(makeStartInput());
    const operation = started.operation;

    const proposal = makeProposal();
    const committed = await commitRequirementBaseline(
      makeDeps(projectRoot, { newId: phaseIds("bl") }),
      makeContext(),
      proposal,
      {
        workflowOperationId: operation.workflow_operation_id,
        attemptId: operation.attempt_id,
        approvalDigest: "f".repeat(64),
      },
    );

    expect(committed.digest).toBe(requirementBaselineDigest(proposal));
    // 1 intent + 1 requirement + 1 constraint + 2 acceptance tests
    expect(committed.nodeIds).toHaveLength(5);

    const replay = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
    }).replay();
    const edgeTypes = replay.edges.map((edge) => edge.type).sort();
    expect(edgeTypes).toEqual(["CONSTRAINED_BY", "DECOMPOSES_TO", "VERIFIES", "VERIFIES"]);

    const documentRaw = readFileSync(
      resolveHarnessPath(
        new LedgerRepository({ projectRoot, readBaseline: () => BASELINE }).harnessRoot,
        baselineDocumentArtifactPath(committed.digest),
      ),
      "utf8",
    );
    const document = JSON.parse(documentRaw) as Record<string, unknown>;
    expect(document.digest).toBe(committed.digest);
    expect(document.approval_digest).toBe("f".repeat(64));
  });

  it("produces schema-valid node artifacts for every captured element", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("op") }));
    const started = await engine.startOperation(makeStartInput());

    const committed = await commitRequirementBaseline(
      makeDeps(projectRoot, { newId: phaseIds("bl") }),
      makeContext(),
      makeProposal(),
      {
        workflowOperationId: started.operation.workflow_operation_id,
        attemptId: started.operation.attempt_id,
        approvalDigest: "f".repeat(64),
      },
    );

    const repository = new LedgerRepository({ projectRoot, readBaseline: () => BASELINE });
    for (const nodeId of committed.nodeIds) {
      const matches = ["intents", "requirements", "constraints", "tests"].map((directory) => {
        const relative = `artifacts/${directory}/${nodeId}.json`;
        try {
          return readFileSync(resolveHarnessPath(repository.harnessRoot, relative), "utf8");
        } catch {
          return undefined;
        }
      });
      const raw = matches.find((entry) => entry !== undefined);
      expect(raw, `node artifact for ${nodeId}`).toBeDefined();
      expect(validateSchema("node", JSON.parse(raw ?? "")).valid).toBe(true);
    }
  });

  it("is idempotent under a retry with the same minted ids", async () => {
    const projectRoot = makeProjectRoot();
    const engine = new WorkflowEngine(makeDeps(projectRoot, { newId: phaseIds("op") }));
    const started = await engine.startOperation(makeStartInput());
    const binding = {
      workflowOperationId: started.operation.workflow_operation_id,
      attemptId: started.operation.attempt_id,
      approvalDigest: "f".repeat(64),
    };
    const proposal = makeProposal();

    const first = await commitRequirementBaseline(
      makeDeps(projectRoot, { newId: phaseIds("bl") }),
      makeContext(),
      proposal,
      binding,
    );
    const second = await commitRequirementBaseline(
      makeDeps(projectRoot, { newId: phaseIds("bl") }),
      makeContext(),
      proposal,
      binding,
    );

    expect(second.ledgerOperationId).toBe(first.ledgerOperationId);
    const replay = new LedgerRepository({
      projectRoot,
      readBaseline: () => BASELINE,
    }).replay();
    expect(replay.operations).toHaveLength(2); // start operation + one baseline commit
  });
});
