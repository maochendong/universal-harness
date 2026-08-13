import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { validateSchema, type EdgeRecord, type NodeRecord } from "../../packages/core/src/index.js";
import { isRelationCompatible } from "../../packages/graph/src/index.js";

import { GENERATOR_SCRIPT } from "./helpers.js";

/**
 * Performance dataset gate (design 16.2, plan Task 27 step 3): the generator
 * produces exactly 20,000 schema-valid nodes and 100,000 schema-valid edges,
 * every record digests deterministically, and two independent runs emit
 * byte-identical files on any platform.
 */
const created: string[] = [];

function generate(): string {
  const out = mkdtempSync(join(tmpdir(), "harness-perf-dataset-"));
  created.push(out);
  execFileSync(process.execPath, [GENERATOR_SCRIPT, "--out", out], { stdio: "pipe" });
  return out;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("performance dataset generation", () => {
  it("produces exactly 20,000 nodes and 100,000 edges, all schema-valid", () => {
    const out = generate();
    const nodes = JSON.parse(readFileSync(join(out, "nodes.json"), "utf8")) as NodeRecord[];
    const edges = JSON.parse(readFileSync(join(out, "edges.json"), "utf8")) as EdgeRecord[];
    expect(nodes).toHaveLength(20_000);
    expect(edges).toHaveLength(100_000);
    for (const node of nodes) {
      expect(validateSchema("node", node).valid, `node ${node.id}`).toBe(true);
    }
    for (const edge of edges) {
      expect(validateSchema("edge", edge).valid, `edge ${edge.id}`).toBe(true);
    }
  }, 120_000);

  it("keeps every edge resolvable and relation-compatible", () => {
    const out = generate();
    const nodes = JSON.parse(readFileSync(join(out, "nodes.json"), "utf8")) as NodeRecord[];
    const edges = JSON.parse(readFileSync(join(out, "edges.json"), "utf8")) as EdgeRecord[];
    const typeById = new Map(nodes.map((node) => [node.id, node.type]));
    expect(typeById.size).toBe(nodes.length);
    const edgeIds = new Set<string>();
    for (const edge of edges) {
      expect(edgeIds.has(edge.id), `duplicate edge id ${edge.id}`).toBe(false);
      edgeIds.add(edge.id);
      const sourceType = typeById.get(edge.source_id);
      const targetType = typeById.get(edge.target_id);
      expect(sourceType, `edge ${edge.id} source`).toBeDefined();
      expect(targetType, `edge ${edge.id} target`).toBeDefined();
      expect(
        isRelationCompatible(
          edge.type,
          sourceType as NodeRecord["type"],
          targetType as NodeRecord["type"],
        ),
        `edge ${edge.id} ${edge.type} ${String(sourceType)} -> ${String(targetType)}`,
      ).toBe(true);
    }
  }, 120_000);

  it("is deterministic: two runs produce byte-identical files and digests", () => {
    const first = generate();
    const second = generate();
    for (const file of ["nodes.json", "edges.json", "manifest.json"]) {
      expect(readFileSync(join(first, file), "utf8"), file).toBe(
        readFileSync(join(second, file), "utf8"),
      );
    }
    const manifest = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8")) as {
      node_count: number;
      edge_count: number;
      nodes_digest: string;
      edges_digest: string;
      dataset_digest: string;
    };
    expect(manifest.node_count).toBe(20_000);
    expect(manifest.edge_count).toBe(100_000);
    expect(manifest.nodes_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.edges_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.dataset_digest).toMatch(/^[a-f0-9]{64}$/u);
  }, 120_000);
});
