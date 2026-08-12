import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalizeJson, harnessRootFor } from "@universal-harness-internal/core";

import { materializeLedger } from "../src/materializer.js";
import { META_KEYS, readMeta } from "../src/sqlite/database.js";
import { pageEdges, pageNodes } from "../src/query-port.js";

import {
  BASELINE,
  commitScenario,
  makeEvent,
  makeNode,
  makeProjectRoot,
  makeRepository,
  scenarioInputs,
} from "./fixtures.js";

describe("materializeLedger", () => {
  it("projects committed operations, nodes, edges and events with cursor metadata", async () => {
    const projectRoot = makeProjectRoot();
    await commitScenario(projectRoot);
    const { database, report } = materializeLedger({
      projectRoot,
      databasePath: ":memory:",
    });
    try {
      expect(report).toMatchObject({
        operationCount: 3,
        nodeCount: 16,
        edgeCount: 19,
        eventCount: 3,
        lastSequence: 3,
        skippedArtifacts: [],
      });
      expect(readMeta(database, META_KEYS.lastSequence)).toBe("3");
      expect(readMeta(database, META_KEYS.projectionDigest)).toBe(report.projectionDigest);
      expect(pageNodes(database, { limit: 500 }).items).toHaveLength(16);
      expect(pageEdges(database, { limit: 500 }).items).toHaveLength(19);
    } finally {
      database.close();
    }
  });

  it("replaces a node with its highest revision", async () => {
    const projectRoot = makeProjectRoot();
    await commitScenario(projectRoot);
    const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      const requirements = pageNodes(database, { type: "Requirement" }).items;
      expect(requirements).toHaveLength(1);
      expect(requirements[0]?.revision).toBe(2);
      expect(requirements[0]?.extensions).toEqual({ "acme.note": "revised" });
    } finally {
      database.close();
    }
  });

  it("applies a later edge revision over the earlier projection", async () => {
    const projectRoot = makeProjectRoot();
    await commitScenario(projectRoot);
    const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      const accepted = pageEdges(database, {
        status: "accepted",
        type: "SUPPORTS",
        limit: 500,
      }).items;
      // The agent-inferred edge keeps its original confidence after acceptance.
      const inferred = accepted.find((edge) => edge.id === "edge-evidence-supports-requirement_01");
      expect(inferred).toMatchObject({ status: "accepted", confidence: 0.6, source: "agent" });
      expect(pageEdges(database, { status: "proposed", limit: 500 }).items).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("never projects files that no committed manifest authorizes", async () => {
    const projectRoot = makeProjectRoot();
    await commitScenario(projectRoot);
    const artifactsDir = join(harnessRootFor(projectRoot), "artifacts", "notes");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "hand-written.json"), '{"record_kind":"node"}\n');
    const { database, report } = materializeLedger({
      projectRoot,
      databasePath: ":memory:",
    });
    try {
      expect(report.skippedArtifacts).toEqual(["artifacts/notes/hand-written.json"]);
      expect(report.nodeCount).toBe(16);
    } finally {
      database.close();
    }
  });

  it("blocks on a revision fork instead of picking a winner", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    const forkA = makeNode({ id: "decision_01", type: "Decision" });
    const forkB = makeNode({
      id: "decision_01",
      type: "Decision",
      extensions: { "acme.note": "fork" },
    });
    const inputs = scenarioInputs();
    await repository.commit({
      ...inputs[0]!,
      artifacts: [
        { path: "artifacts/decisions/decision_01.json", content: `${canonicalizeJson(forkA)}\n` },
      ],
    });
    await repository.commit({
      ledger_operation_id: "ledger-op_02",
      workflow_operation_id: "workflow-op_01",
      attempt_id: "attempt_01",
      expected_baseline: BASELINE,
      artifacts: [
        {
          path: "artifacts/decisions/decision_01.fork.json",
          content: `${canonicalizeJson(forkB)}\n`,
        },
      ],
    });
    expect(() => materializeLedger({ projectRoot, databasePath: ":memory:" })).toThrowError(
      expect.objectContaining({ kind: "revision_fork" }),
    );
  });

  it("blocks on conflicting events sharing an event id", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    const inputs = scenarioInputs();
    await repository.commit(inputs[0]!);
    await repository.commit({
      ledger_operation_id: "ledger-op_02",
      workflow_operation_id: "workflow-op_01",
      attempt_id: "attempt_01",
      expected_baseline: BASELINE,
      events: [{ ...makeEvent("event-op-01-started_01", "OperationCompleted", "ledger-op_02") }],
    });
    expect(() => materializeLedger({ projectRoot, databasePath: ":memory:" })).toThrowError(
      expect.objectContaining({ kind: "conflicting_event" }),
    );
  });

  it("blocks on an authoritative artifact that is not a valid node record", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    await repository.commit({
      ledger_operation_id: "ledger-op_01",
      workflow_operation_id: "workflow-op_01",
      attempt_id: "attempt_01",
      expected_baseline: BASELINE,
      artifacts: [
        {
          path: "artifacts/decisions/decision_01.json",
          content: '{"record_kind":"node","id":"decision_01"}\n',
        },
      ],
    });
    expect(() => materializeLedger({ projectRoot, databasePath: ":memory:" })).toThrowError(
      expect.objectContaining({ kind: "invalid_artifact" }),
    );
  });

  it("rebuilds an identical projection after the cache is deleted", async () => {
    const projectRoot = makeProjectRoot();
    await commitScenario(projectRoot);
    const databasePath = join(projectRoot, ".harness", "cache", "graph.db");

    const first = materializeLedger({ projectRoot, databasePath });
    const firstNodes = pageNodes(first.database, { limit: 500 }).items;
    const firstEdges = pageEdges(first.database, { limit: 500 }).items;
    first.database.close();

    rmSync(databasePath);
    const second = materializeLedger({ projectRoot, databasePath });
    try {
      expect(second.report.projectionDigest).toBe(first.report.projectionDigest);
      expect(second.report).toEqual(first.report);
      expect(pageNodes(second.database, { limit: 500 }).items).toEqual(firstNodes);
      expect(pageEdges(second.database, { limit: 500 }).items).toEqual(firstEdges);
    } finally {
      second.database.close();
    }
  });

  it("materializes an empty ledger as an empty projection", () => {
    const projectRoot = makeProjectRoot();
    const { database, report } = materializeLedger({ projectRoot, databasePath: ":memory:" });
    try {
      expect(report).toMatchObject({
        operationCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        eventCount: 0,
        lastSequence: 0,
      });
    } finally {
      database.close();
    }
  });

  it("ignores authoritative extension files that are not node records", async () => {
    const projectRoot = makeProjectRoot();
    const repository = makeRepository(projectRoot);
    const inputs = scenarioInputs();
    const narrative = "human narrative, not JSON at all\n";
    await repository.commit({
      ...inputs[0]!,
      artifacts: [
        ...(inputs[0]!.artifacts ?? []),
        { path: "artifacts/decisions/decision_01.notes.md", content: narrative },
      ],
    });
    // The narrative digest is recorded by the manifest, yet never projected.
    const { database, report } = materializeLedger({
      projectRoot,
      databasePath: ":memory:",
    });
    try {
      expect(report.skippedArtifacts).toEqual([]);
      expect(report.nodeCount).toBe(9);
    } finally {
      database.close();
    }
  });
});
