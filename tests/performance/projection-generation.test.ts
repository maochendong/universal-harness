import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  renderArchitectureProjection,
  renderPrdProjection,
  type ProjectionGraph,
} from "../../adapters/projection-markdown/src/index.js";

import { loadDataset, measure, recordBaseline, summarizeSamples } from "./helpers.js";

/**
 * Projection generation baseline (design 16.2, plan Task 27 step 5): M1
 * records p50/p95/max with operation scale and CI environment instead of
 * inventing a hard threshold, and a missing baseline blocks release. Both the
 * full 20k/100k graph and the affected slice an iteration actually
 * regenerates are measured; rendering the same graph must regenerate
 * byte-identical documents.
 */
const FULL_RUNS = 3;
const SLICE_RUNS = 15;

/**
 * The slice an affected-projection run regenerates: the first decisions,
 * requirements, components, code artifacts and tests plus every edge between
 * them -- a deterministic subrange of the generated dataset.
 */
function affectedSlice(graph: ProjectionGraph): ProjectionGraph {
  const inRange = (id: string, prefix: string, count: number, width: number): boolean => {
    if (!id.startsWith(prefix)) return false;
    const index = Number(id.slice(prefix.length));
    return (
      Number.isInteger(index) &&
      index >= 0 &&
      index < count &&
      id === `${prefix}${String(index).padStart(width, "0")}`
    );
  };
  const keep = (id: string): boolean =>
    inRange(id, "decision_d", 50, 5) ||
    inRange(id, "requirement_r", 100, 5) ||
    inRange(id, "component_c", 400, 5) ||
    inRange(id, "code_m", 1400, 5) ||
    inRange(id, "test_t", 100, 5);
  const nodes = graph.nodes.filter((node) => keep(node.id));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.source_id) && ids.has(edge.target_id));
  return { nodes, edges };
}

describe("projection generation baseline", () => {
  it("records p50/p95/max for full-graph and affected-slice rendering", () => {
    const { nodes, edges } = loadDataset();
    const graph: ProjectionGraph = { nodes, edges };
    const slice = affectedSlice(graph);
    expect(slice.nodes.length).toBeGreaterThan(0);
    expect(slice.edges.length).toBeGreaterThan(0);

    // Full dataset: few samples (this is the expensive path), still enough
    // for a recorded max; the slice below carries the percentile baseline.
    const fullSamples: number[] = [];
    let reference = "";
    for (let run = 0; run < FULL_RUNS; run += 1) {
      const render = measure(() => renderArchitectureProjection(graph));
      fullSamples.push(render.elapsedMs);
      if (reference === "") reference = render.result.markdown;
      // Determinism: the same graph regenerates byte-identical output.
      expect(render.result.markdown).toBe(reference);
    }

    const sliceSamples: number[] = [];
    let sliceReference = "";
    for (let run = 0; run < SLICE_RUNS; run += 1) {
      const render = measure(() => renderArchitectureProjection(slice));
      sliceSamples.push(render.elapsedMs);
      if (sliceReference === "") sliceReference = render.result.markdown;
      expect(render.result.markdown).toBe(sliceReference);
    }

    const path = recordBaseline("projection-generation", {
      metric: "projection_generation",
      views: {
        architecture_full: summarizeSamples(fullSamples),
        architecture_affected_slice: summarizeSamples(sliceSamples),
        // PRD renders over the full dataset but short-circuits without
        // intents; recorded once so the view is covered by the baseline.
        prd_full: summarizeSamples([measure(() => renderPrdProjection(graph)).elapsedMs]),
      },
      operation_scale: {
        full: { nodes: nodes.length, edges: edges.length, renders: FULL_RUNS },
        affected_slice: {
          nodes: slice.nodes.length,
          edges: slice.edges.length,
          renders: SLICE_RUNS,
        },
      },
    });
    const recorded = JSON.parse(readFileSync(path, "utf8")) as {
      views: { architecture_affected_slice: { p50_ms: number; p95_ms: number; max_ms: number } };
      operation_scale: { full: { nodes: number; edges: number } };
      environment: { platform: string };
    };
    const sliceSummary = recorded.views.architecture_affected_slice;
    expect(sliceSummary.p95_ms).toBeGreaterThanOrEqual(sliceSummary.p50_ms);
    expect(sliceSummary.max_ms).toBeGreaterThanOrEqual(sliceSummary.p95_ms);
    expect(recorded.operation_scale.full.nodes).toBe(20_000);
    expect(recorded.operation_scale.full.edges).toBe(100_000);
  }, 300_000);
});
