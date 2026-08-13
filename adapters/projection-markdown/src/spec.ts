import type { NodeRecord } from "@universal-harness-internal/core";

import {
  REQUIREMENTS_EXTENSION_KEY,
  activeEdges,
  buildProjectionDocument,
  currentNodeMap,
  edgesFrom,
  edgesTo,
  extensionText,
  nodesOfType,
  type ProjectionDocument,
  type ProjectionGraph,
  type ProjectionSource,
} from "./index.js";

/**
 * Specification projection (design 13.7): the verifiable contract view.
 * Every accepted Requirement and Constraint is rendered with the Tests that
 * verify it, so the specification always shows how each statement is proven.
 */
export function renderSpecificationProjection(graph: ProjectionGraph): ProjectionDocument {
  const nodes = currentNodeMap(graph);
  const edges = activeEdges(graph);
  const sources: ProjectionSource[] = [];
  const body: string[] = ["# Specification", ""];

  const subjects = [...nodesOfType(nodes, "Requirement"), ...nodesOfType(nodes, "Constraint")];
  if (subjects.length === 0) {
    body.push("No requirements or constraints recorded.");
    return buildProjectionDocument("spec", sources, body);
  }

  for (const subject of subjects) {
    sources.push({ id: subject.id, revision: subject.revision });
    const statement = extensionText(subject, REQUIREMENTS_EXTENSION_KEY, "statement");
    body.push(`## ${subject.type} ${subject.id} (revision ${subject.revision})`, "");
    if (statement !== undefined) body.push(statement, "");
    const constraints = edgesFrom(edges, subject.id, "CONSTRAINED_BY")
      .map((edge) => nodes.get(edge.target_id))
      .filter((node): node is NodeRecord => node !== undefined && node.type === "Constraint");
    if (constraints.length > 0) {
      body.push(`Constrained by: ${constraints.map((node) => node.id).join(", ")}`, "");
      for (const constraint of constraints) {
        sources.push({ id: constraint.id, revision: constraint.revision });
      }
    }
    const tests = edgesTo(edges, subject.id, "VERIFIES")
      .map((edge) => nodes.get(edge.source_id))
      .filter((node): node is NodeRecord => node !== undefined && node.type === "Test");
    if (tests.length === 0) {
      body.push("Verification: no test verifies this subject yet.", "");
    } else {
      body.push("### Verification", "");
      for (const test of tests) {
        sources.push({ id: test.id, revision: test.revision });
        const description = extensionText(test, REQUIREMENTS_EXTENSION_KEY, "description");
        const verification = extensionText(test, REQUIREMENTS_EXTENSION_KEY, "verification");
        const suffix = verification === undefined ? "" : ` (verified by: ${verification})`;
        body.push(`- ${test.id}: ${description ?? ""}${suffix}`);
      }
      body.push("");
    }
  }

  return buildProjectionDocument("spec", sources, body);
}
