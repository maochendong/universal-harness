import { describe, expect, it, vi } from "vitest";

import {
  contentDigest,
  createPromptContractRegistry,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  IMPACT_ADVISORY_PROMPT_REGISTRATION,
  RELATION_RULE_REGISTRY,
  type ImpactAdvisoryInput,
} from "@universal-harness-internal/graph";
import type { ImpactAdvisoryOutput } from "@universal-harness-internal/core";

import {
  createModelBackedImpactAdvisoryPort,
  type ImpactAdvisoryAdapterDeps,
} from "../../src/model/impact-advisory-adapter.js";
import { readModelInvocationRecords } from "../../src/model/invocation-store.js";
import type { ManagedModelProviderPort } from "../../src/model/managed-runner.js";
import { makeTempDir } from "../bootstrap/helpers.js";

/**
 * PG-3 runtime adapter: the model-backed advisory port compiles the real
 * impact-advisory contract, invokes through the managed runner and fails
 * closed on any output the merge validator rejects.
 */
function makeNode(id: string, type: NodeRecord["type"]): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id,
    type,
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "adapter-test",
      timestamp: "2026-08-20T00:00:00Z",
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

const NODES = [
  makeNode("requirement_01", "Requirement"),
  makeNode("code-artifact_02", "CodeArtifact"),
];
const NODE_DIGEST = new Map(NODES.map((node) => [node.id, node.digest]));

function advisoryInput(): ImpactAdvisoryInput {
  return {
    workflow_operation_id: "operation_01K1ABC",
    iteration_id: "iteration_01K1ABC",
    impact_set_digest: "a".repeat(64),
    deterministic_entries: [
      {
        node_id: "requirement_01",
        node_type: "Requirement",
        classification: "must-change",
        risk: "high",
        confidence: 1,
        path: [],
        reason: "directly seeded",
        seed_id: "seed_01",
      },
    ],
    nodes: NODES,
    requirement_digests: {},
    rule_registry_version: RELATION_RULE_REGISTRY.version,
    rule_registry_digest: RELATION_RULE_REGISTRY.digest,
    conversation_id: "conversation_01K1ABC",
    run_id: "run_01K1ABC",
  };
}

function advisoryOutput(overrides: Partial<ImpactAdvisoryOutput> = {}): ImpactAdvisoryOutput {
  return {
    purpose: "impact_advisory",
    schema_version: "impact-advisory.v1",
    impact_set_digest: "a".repeat(64),
    additions: [],
    edge_candidates: [],
    risk_signals: [],
    missing_facts: [],
    questions: [],
    ...overrides,
  };
}

function deps(root: string, provider: ManagedModelProviderPort): ImpactAdvisoryAdapterDeps {
  return {
    projectRoot: root,
    registry: createPromptContractRegistry([IMPACT_ADVISORY_PROMPT_REGISTRATION]),
    profile_id: "standard",
    provider_config: {
      provider_identity: "provider_anthropic",
      config_digest: "0".repeat(64),
      budget_profile: "operation-standard",
    },
    provider,
  };
}

function providerReturning(output: ImpactAdvisoryOutput): ManagedModelProviderPort {
  return { invoke: vi.fn(async () => ({ ok: true as const, content: JSON.stringify(output) })) };
}

describe("model-backed impact advisory adapter", () => {
  it("compiles, invokes, merge-validates and consumes a clean advisory", async () => {
    const root = makeTempDir("harness-impact-adapter-");
    const output = advisoryOutput({
      additions: [
        {
          node_id: "code-artifact_02",
          node_type: "CodeArtifact",
          classification: "inspect",
          risk: "medium",
          confidence: 0.6,
          reason: "shares the export path",
          source_refs: [
            {
              kind: "graph_node",
              ref: "code-artifact_02",
              digest: NODE_DIGEST.get("code-artifact_02")!,
            },
          ],
        },
      ],
    });
    const port = createModelBackedImpactAdvisoryPort(deps(root, providerReturning(output)));
    const result = await port.advise(advisoryInput());
    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") return;
    expect(result.additions).toHaveLength(1);
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated", "consumed"]);
  });

  it("fails closed on an unmergable advisory and never consumes it", async () => {
    const root = makeTempDir("harness-impact-adapter-");
    const output = advisoryOutput({
      additions: [
        {
          node_id: "requirement_01",
          node_type: "Requirement",
          classification: "informational",
          risk: "low",
          confidence: 0.9,
          reason: "rewrite the deterministic entry",
          source_refs: [
            {
              kind: "graph_node",
              ref: "requirement_01",
              digest: NODE_DIGEST.get("requirement_01")!,
            },
          ],
        },
      ],
    });
    const port = createModelBackedImpactAdvisoryPort(deps(root, providerReturning(output)));
    const result = await port.advise(advisoryInput());
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.code).toBe("invalid_output");
    expect(result.failure.summary).toContain("deterministic_entry_mutation");
    const states = readModelInvocationRecords(root).map((record) => record.state);
    expect(states).toEqual(["planned", "started", "completed", "validated"]);
  });

  it("maps a question-only advisory to clarification_required", async () => {
    const root = makeTempDir("harness-impact-adapter-");
    const output = advisoryOutput({
      questions: [
        { question: "does the export path include the audit log?", target_id: "code-artifact_02" },
      ],
    });
    const port = createModelBackedImpactAdvisoryPort(deps(root, providerReturning(output)));
    const result = await port.advise(advisoryInput());
    expect(result.status).toBe("clarification_required");
  });

  it("rejects an advisory that drifts from the advised set digest", async () => {
    const root = makeTempDir("harness-impact-adapter-");
    const output = advisoryOutput({ impact_set_digest: "9".repeat(64) });
    const port = createModelBackedImpactAdvisoryPort(deps(root, providerReturning(output)));
    const result = await port.advise(advisoryInput());
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.summary).toContain("stale_impact_set");
  });
});
