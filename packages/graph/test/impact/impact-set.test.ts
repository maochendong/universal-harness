import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateSchema } from "@universal-harness-internal/core";

import {
  ImpactError,
  assertApprovedImpactSet,
  freezeImpactSet,
  generateImpactSet,
  impactSetContentDigest,
  proposedEdgeFromSuggestion,
  readImpactSetContent,
  type ImpactSetContent,
} from "../../src/impact/impact-set.js";
import { seedFromFinding, seedFromRescan, type ChangeSeed } from "../../src/impact/seeds.js";

import { IMPACT_CONTEXT, IMPACT_EDGES, IMPACT_NODES } from "./fixtures.js";

const goldenDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tests/golden/impact",
);

function readGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as unknown;
}

const DIGEST_BEFORE = "0".repeat(64);
const DIGEST_AFTER = "1".repeat(64);

function contentSeed(nodeId: string, iterationKind: ChangeSeed["iterationKind"]): ChangeSeed {
  const seed = seedFromRescan(
    {
      nodeId,
      previous: { locator: `repo://repository_01/${nodeId}`, digest: DIGEST_BEFORE },
      next: { locator: `repo://repository_01/${nodeId}`, digest: DIGEST_AFTER },
    },
    iterationKind,
  );
  if (seed === undefined) throw new Error("expected a content-change seed");
  return seed;
}

function renameSeed(): ChangeSeed {
  const seed = seedFromRescan(
    {
      nodeId: "code_03",
      previous: { locator: "repo://repository_01/src/widget.ts", digest: DIGEST_BEFORE },
      next: { locator: "repo://repository_01/src/renamed-widget.ts", digest: DIGEST_BEFORE },
    },
    "refactor",
  );
  if (seed === undefined) throw new Error("expected a pure-rename seed");
  return seed;
}

function findingSeed(): ChangeSeed {
  const finding = IMPACT_NODES.find((node) => node.id === "finding_01");
  if (finding === undefined) throw new Error("fixture finding missing");
  return seedFromFinding(finding, "security");
}

export const SCENARIOS: Readonly<Record<string, () => ChangeSeed[]>> = {
  feature: () => [contentSeed("requirement_01", "feature")],
  bugfix: () => [contentSeed("decision_01", "bugfix")],
  refactor: () => [contentSeed("requirement_01", "refactor")],
  security: () => [contentSeed("requirement_01", "security")],
  maintenance: () => [contentSeed("code_01", "maintenance")],
  finding: () => [findingSeed()],
  "pure-rename": () => [renameSeed()],
};

export function summarizeScenario(name: string): Record<string, unknown> {
  const impactSet = generateImpactSet(
    SCENARIOS[name]?.() ?? [],
    IMPACT_NODES,
    IMPACT_EDGES,
    IMPACT_CONTEXT,
  );
  const content: ImpactSetContent = readImpactSetContent(impactSet);
  return {
    scenario: name,
    impactSet: {
      id: impactSet.id,
      status: impactSet.status,
      digest: impactSet.digest,
    },
    content,
  };
}

describe("impact set generation", () => {
  it.each(Object.keys(SCENARIOS))("pins the %s scenario golden", (name) => {
    expect(summarizeScenario(name)).toEqual(readGolden(`${name}.json`));
  });

  it("produces schema-valid ImpactSet nodes", () => {
    for (const name of Object.keys(SCENARIOS)) {
      const impactSet = generateImpactSet(
        SCENARIOS[name]?.() ?? [],
        IMPACT_NODES,
        IMPACT_EDGES,
        IMPACT_CONTEXT,
      );
      const result = validateSchema("node", impactSet);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    }
  });

  it("is deterministic regardless of graph record ordering", () => {
    const seeds = SCENARIOS.feature?.() ?? [];
    const baseline = generateImpactSet(seeds, IMPACT_NODES, IMPACT_EDGES, IMPACT_CONTEXT);
    const shuffled = generateImpactSet(
      seeds,
      [...IMPACT_NODES].reverse(),
      [...IMPACT_EDGES].reverse(),
      IMPACT_CONTEXT,
    );
    expect(impactSetContentDigest(shuffled)).toBe(impactSetContentDigest(baseline));
    expect(shuffled.id).toBe(baseline.id);
  });

  it("never marks unrelated artifacts as must-change", () => {
    for (const name of Object.keys(SCENARIOS)) {
      const impactSet = generateImpactSet(
        SCENARIOS[name]?.() ?? [],
        IMPACT_NODES,
        IMPACT_EDGES,
        IMPACT_CONTEXT,
      );
      const entries = readImpactSetContent(impactSet).entries;
      const unrelated = entries.filter(
        (entry) => entry.node_id === "code_02" || entry.node_id === "component_02",
      );
      expect(unrelated, name).toEqual([]);
      const mustChange = entries.filter((entry) => entry.classification === "must-change");
      const reachable = new Set(entries.map((entry) => entry.node_id));
      for (const entry of mustChange) expect(reachable.has(entry.node_id)).toBe(true);
    }
  });

  it("freezes a proposed set with the approval digest and verifies the binding", () => {
    const impactSet = generateImpactSet(
      SCENARIOS.feature?.() ?? [],
      IMPACT_NODES,
      IMPACT_EDGES,
      IMPACT_CONTEXT,
    );
    const approvedDigest = impactSetContentDigest(impactSet);
    const frozen = freezeImpactSet(impactSet, "f".repeat(64));
    expect(frozen.status).toBe("accepted");
    expect(frozen.revision).toBe(impactSet.revision + 1);
    expect(validateSchema("node", frozen).valid).toBe(true);
    expect(() => assertApprovedImpactSet(frozen, approvedDigest)).not.toThrow();
    // Drift against any binding invalidates the frozen set for planning.
    expect(() => assertApprovedImpactSet(frozen, "e".repeat(64))).toThrow(ImpactError);
    expect(() => assertApprovedImpactSet(impactSet, approvedDigest)).toThrow(ImpactError);
    expect(() => freezeImpactSet(frozen, "f".repeat(64))).toThrow(ImpactError);
  });

  it("isolates semantic suggestions as proposed edges with reason and confidence", () => {
    const edge = proposedEdgeFromSuggestion(
      {
        relation: "ADDRESSES",
        sourceId: "decision_02",
        targetId: "requirement_01",
        confidence: 0.5,
        reason: "model inferred the decision addresses the requirement",
      },
      IMPACT_NODES,
      { id: "edge-suggested_01", ...IMPACT_CONTEXT },
    );
    expect(edge.status).toBe("proposed");
    expect(edge.source).toBe("agent");
    expect(edge.confidence).toBe(0.5);
    expect(edge.extensions?.["harness.impact"]).toEqual({
      reason: "model inferred the decision addresses the requirement",
    });
    expect(validateSchema("edge", edge).valid).toBe(true);
  });

  it("rejects incompatible, overconfident or dangling suggestions", () => {
    const context = { id: "edge-suggested_02", ...IMPACT_CONTEXT };
    expect(() =>
      proposedEdgeFromSuggestion(
        {
          relation: "SHAPES",
          sourceId: "code_01",
          targetId: "task_01",
          confidence: 0.4,
          reason: "x",
        },
        IMPACT_NODES,
        context,
      ),
    ).toThrow(ImpactError);
    expect(() =>
      proposedEdgeFromSuggestion(
        {
          relation: "ADDRESSES",
          sourceId: "decision_02",
          targetId: "requirement_01",
          confidence: 1,
          reason: "x",
        },
        IMPACT_NODES,
        context,
      ),
    ).toThrow(ImpactError);
    expect(() =>
      proposedEdgeFromSuggestion(
        {
          relation: "ADDRESSES",
          sourceId: "decision_02",
          targetId: "node_missing",
          confidence: 0.4,
          reason: "x",
        },
        IMPACT_NODES,
        context,
      ),
    ).toThrow(ImpactError);
  });

  it("requires at least one seed", () => {
    expect(() => generateImpactSet([], IMPACT_NODES, IMPACT_EDGES, IMPACT_CONTEXT)).toThrow(
      ImpactError,
    );
  });
});
