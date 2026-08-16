import { beforeAll, describe, expect, it } from "vitest";

import { createGraphReadPorts, materializeLedger, type Materialization } from "../src/index.js";

import { commitScenario, makeProjectRoot } from "./fixtures.js";

describe("graph read ports", () => {
  let materialization: Materialization;

  beforeAll(async () => {
    const projectRoot = makeProjectRoot();
    await commitScenario(projectRoot);
    materialization = materializeLedger({ projectRoot, databasePath: ":memory:" });
    return () => {
      materialization.database.close();
    };
  });

  it("exposes stable general queries and view-scoped execution queries through one port bundle", () => {
    const ports = createGraphReadPorts(materialization.database);

    expect(ports.graph.pageNodes({ type: "Requirement" }).items.map((node) => node.id)).toEqual([
      "requirement_01",
    ]);
    expect(ports.execution.getNode("run_01")?.type).toBe("Run");
    expect(ports.execution.getNode("requirement_01")).toBeUndefined();
    expect(
      ports.graph.shortestPath("run_01", "requirement_01")?.nodes.map((node) => node.id),
    ).toEqual(["run_01", "evidence_01", "requirement_01"]);
  });
});
