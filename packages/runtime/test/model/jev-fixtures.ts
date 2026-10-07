import {
  contentDigest,
  createPromptContractRegistry,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  JEV_IMPACT_PROMPT_REGISTRATION,
  RELATION_RULE_REGISTRY,
  type ImpactAdvisoryInput,
} from "@universal-harness-internal/graph";

export function jevNode(id: string, patch: Partial<Omit<NodeRecord, "digest">> = {}): NodeRecord {
  const record = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id,
    type: "Requirement",
    revision: 1,
    status: "accepted",
    source: "workflow",
    confidence: 1,
    provenance: { iteration_id: "iteration_01", actor: "test", timestamp: "2026-09-28T00:00:00Z" },
    extensions: {
      "harness.requirements": {
        statement:
          id === "requirement_seed"
            ? "Change exported reports to JSON"
            : "Read exported reports as CSV",
      },
    },
    ...patch,
  } as const;
  return { ...record, digest: contentDigest(record) };
}

export function jevInput(
  nodes = [jevNode("requirement_seed"), jevNode("requirement_consumer")],
): ImpactAdvisoryInput {
  const seed = nodes[0]!;
  return {
    workflow_operation_id: "operation_jev",
    iteration_id: "iteration_01",
    impact_set_digest: "a".repeat(64),
    deterministic_entries: [
      {
        node_id: seed.id,
        node_type: seed.type,
        classification: "must-change",
        risk: "medium",
        confidence: 1,
        path: [],
        reason: "seed",
        seed_id: "seed_01",
      },
    ],
    nodes,
    requirement_digests: { [seed.id]: seed.digest },
    rule_registry_version: RELATION_RULE_REGISTRY.version,
    rule_registry_digest: RELATION_RULE_REGISTRY.digest,
    conversation_id: "conversation_01",
    run_id: "run_01",
  };
}

export function jevRegistry() {
  return createPromptContractRegistry([JEV_IMPACT_PROMPT_REGISTRATION]);
}
