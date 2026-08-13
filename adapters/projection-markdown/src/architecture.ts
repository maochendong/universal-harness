import type { NodeRecord } from "@universal-harness-internal/core";

import {
  activeEdges,
  buildProjectionDocument,
  currentNodeMap,
  edgesFrom,
  edgesTo,
  nodesOfType,
  type ProjectionDocument,
  type ProjectionGraph,
  type ProjectionSource,
} from "./index.js";

/**
 * Architecture projection (design 13.7): Decisions address Requirements and
 * shape Components; CodeArtifacts realize Components. The view renders the
 * accepted design reasoning exactly as the graph records it.
 */
export function renderArchitectureProjection(graph: ProjectionGraph): ProjectionDocument {
  const nodes = currentNodeMap(graph);
  const edges = activeEdges(graph);
  const sources: ProjectionSource[] = [];
  const body: string[] = ["# Architecture", ""];

  const decisions = nodesOfType(nodes, "Decision");
  if (decisions.length === 0) {
    body.push("## Decisions", "", "No decisions recorded.", "");
  } else {
    body.push("## Decisions", "");
    for (const decision of decisions) {
      sources.push({ id: decision.id, revision: decision.revision });
      body.push(`### ${decision.id} (revision ${decision.revision})`, "");
      const addresses = edgesFrom(edges, decision.id, "ADDRESSES")
        .map((edge) => nodes.get(edge.target_id))
        .filter((node): node is NodeRecord => node !== undefined);
      if (addresses.length > 0) {
        for (const target of addresses) sources.push({ id: target.id, revision: target.revision });
        body.push(`Addresses: ${addresses.map((node) => node.id).join(", ")}`, "");
      }
      const shapes = edgesFrom(edges, decision.id, "SHAPES")
        .map((edge) => nodes.get(edge.target_id))
        .filter((node): node is NodeRecord => node !== undefined);
      if (shapes.length > 0) {
        for (const target of shapes) sources.push({ id: target.id, revision: target.revision });
        body.push(`Shapes: ${shapes.map((node) => node.id).join(", ")}`, "");
      }
    }
  }

  const components = nodesOfType(nodes, "Component");
  if (components.length === 0) {
    body.push("## Components", "", "No components recorded.", "");
  } else {
    body.push("## Components", "");
    for (const component of components) {
      sources.push({ id: component.id, revision: component.revision });
      body.push(`### ${component.id} (revision ${component.revision})`, "");
      const realizations = edgesTo(edges, component.id, "REALIZES")
        .map((edge) => nodes.get(edge.source_id))
        .filter((node): node is NodeRecord => node !== undefined);
      if (realizations.length === 0) {
        body.push("Realized by: none recorded.", "");
      } else {
        body.push("Realized by:", "");
        for (const artifact of realizations) {
          sources.push({ id: artifact.id, revision: artifact.revision });
          const locator = artifact.locator === undefined ? "" : ` (${artifact.locator})`;
          body.push(`- ${artifact.id}${locator}`);
        }
        body.push("");
      }
    }
  }

  return buildProjectionDocument("architecture", sources, body);
}
