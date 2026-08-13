import type { NodeRecord } from "@universal-harness-internal/core";

import {
  REQUIREMENTS_EXTENSION_KEY,
  activeEdges,
  buildProjectionDocument,
  currentNodeMap,
  edgesFrom,
  edgesTo,
  extensionEntries,
  extensionText,
  nodesOfType,
  type ProjectionDocument,
  type ProjectionGraph,
  type ProjectionSource,
} from "./index.js";

/**
 * PRD projection (design 13.7): Intent decomposes into Requirements, each
 * Requirement carries its acceptance criteria and is constrained by the
 * Constraints bound through CONSTRAINED_BY edges. Purely derived from the
 * graph; editing the Markdown never edits the ledger.
 */
export function renderPrdProjection(graph: ProjectionGraph): ProjectionDocument {
  const nodes = currentNodeMap(graph);
  const edges = activeEdges(graph);
  const sources: ProjectionSource[] = [];
  const body: string[] = [];

  const intents = nodesOfType(nodes, "Intent");
  if (intents.length === 0) {
    body.push("# Product Requirements", "", "No intent has been captured yet.");
    return buildProjectionDocument("prd", sources, body);
  }

  for (const intent of intents) {
    sources.push({ id: intent.id, revision: intent.revision });
    const text = extensionText(intent, REQUIREMENTS_EXTENSION_KEY, "text");
    body.push(`# Product Requirements: ${text ?? intent.id}`, "");
    const requirements = edgesFrom(edges, intent.id, "DECOMPOSES_TO")
      .map((edge) => nodes.get(edge.target_id))
      .filter((node): node is NodeRecord => node !== undefined && node.type === "Requirement");
    if (requirements.length === 0) body.push("No requirements recorded for this intent.", "");
    for (const requirement of requirements) {
      sources.push({ id: requirement.id, revision: requirement.revision });
      const statement = extensionText(requirement, REQUIREMENTS_EXTENSION_KEY, "statement");
      body.push(`## ${requirement.id} (revision ${requirement.revision})`, "");
      if (statement !== undefined) body.push(statement, "");
      const acceptance = extensionEntries(requirement, REQUIREMENTS_EXTENSION_KEY, "acceptance");
      if (acceptance.length > 0) {
        body.push("### Acceptance Criteria", "");
        for (const criterion of acceptance) {
          const description =
            typeof criterion.description === "string" ? criterion.description : "";
          const verification =
            typeof criterion.verification === "string" ? criterion.verification : "";
          body.push(`- ${description} (verified by: ${verification})`);
        }
        body.push("");
      }
      const constraints = edgesFrom(edges, requirement.id, "CONSTRAINED_BY")
        .map((edge) => nodes.get(edge.target_id))
        .filter((node): node is NodeRecord => node !== undefined && node.type === "Constraint");
      if (constraints.length > 0) {
        body.push("### Constraints", "");
        for (const constraint of constraints) {
          sources.push({ id: constraint.id, revision: constraint.revision });
          const constraintStatement = extensionText(
            constraint,
            REQUIREMENTS_EXTENSION_KEY,
            "statement",
          );
          const verification = extensionText(
            constraint,
            REQUIREMENTS_EXTENSION_KEY,
            "verification",
          );
          const suffix = verification === undefined ? "" : ` (verified by: ${verification})`;
          body.push(`- ${constraint.id}: ${constraintStatement ?? ""}${suffix}`);
        }
        body.push("");
      }
      const tests = edgesTo(edges, requirement.id, "VERIFIES")
        .map((edge) => nodes.get(edge.source_id))
        .filter((node): node is NodeRecord => node !== undefined && node.type === "Test");
      if (tests.length > 0) {
        for (const test of tests) sources.push({ id: test.id, revision: test.revision });
        body.push(`Verified by: ${tests.map((test) => test.id).join(", ")}`, "");
      }
    }
  }

  return buildProjectionDocument("prd", sources, body);
}
