import { describe, expect, it } from "vitest";

import {
  ImpactError,
  seedFromFinding,
  seedFromImprovementCandidate,
  seedFromRescan,
} from "../../src/impact/seeds.js";

import { IMPACT_NODES } from "./fixtures.js";

const LOCATOR_A = "repo://repository_01/src/widget.ts";
const LOCATOR_B = "repo://repository_01/src/renamed-widget.ts";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function nodeOf(id: string) {
  const node = IMPACT_NODES.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`fixture node ${id} missing`);
  return node;
}

describe("change seeds", () => {
  it("derives no seed from an unchanged rescan", () => {
    const snapshot = { locator: LOCATOR_A, digest: DIGEST_A };
    expect(
      seedFromRescan({ nodeId: "code_01", previous: snapshot, next: snapshot }, "feature"),
    ).toBeUndefined();
  });

  it("classifies a locator-only move as a pure-rename seed", () => {
    const seed = seedFromRescan(
      {
        nodeId: "code_03",
        previous: { locator: LOCATOR_A, digest: DIGEST_A },
        next: { locator: LOCATOR_B, digest: DIGEST_A },
      },
      "refactor",
    );
    expect(seed?.kind).toBe("pure-rename");
    expect(seed?.nodeId).toBe("code_03");
    expect(seed?.reason).toContain("content digest unchanged");
  });

  it("classifies digest changes as content-change and rename-with-change seeds", () => {
    const content = seedFromRescan(
      {
        nodeId: "code_01",
        previous: { locator: LOCATOR_A, digest: DIGEST_A },
        next: { locator: LOCATOR_A, digest: DIGEST_B },
      },
      "bugfix",
    );
    expect(content?.kind).toBe("content-change");
    const both = seedFromRescan(
      {
        nodeId: "code_01",
        previous: { locator: LOCATOR_A, digest: DIGEST_A },
        next: { locator: LOCATOR_B, digest: DIGEST_B },
      },
      "feature",
    );
    expect(both?.kind).toBe("rename-with-change");
  });

  it("produces deterministic seed ids independent of input ordering", () => {
    const change = {
      nodeId: "code_01",
      previous: { locator: LOCATOR_A, digest: DIGEST_A },
      next: { locator: LOCATOR_A, digest: DIGEST_B },
    };
    const first = seedFromRescan(change, "feature");
    const second = seedFromRescan({ ...change }, "feature");
    expect(first).toEqual(second);
    expect(first?.id).toMatch(/^seed_[a-f0-9]{16}$/);
  });

  it("derives finding and improvement seeds only from the right node types", () => {
    const finding = seedFromFinding(nodeOf("finding_01"), "security");
    expect(finding.kind).toBe("finding");
    expect(finding.nodeId).toBe("finding_01");
    const improvement = seedFromImprovementCandidate(nodeOf("improvement_01"), "maintenance");
    expect(improvement.kind).toBe("improvement");
    expect(() => seedFromFinding(nodeOf("requirement_01"), "bugfix")).toThrow(ImpactError);
    expect(() => seedFromImprovementCandidate(nodeOf("finding_01"), "bugfix")).toThrow(ImpactError);
  });
});
