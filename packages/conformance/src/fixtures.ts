import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  contentDigest,
  PROTOCOL_VERSION,
  type EdgeRecord,
  type NodeRecord,
  type PluginManifest,
} from "@universal-harness-internal/core";
import type { AgentTaskEnvelope, ProjectionGraph } from "@universal-harness-internal/plugin-sdk";

/**
 * Deterministic conformance fixtures (plan Task 24). Every value is fixed --
 * ids, timestamps and digests never depend on wall time or randomness -- so a
 * conformance report is reproducible run over run.
 */

export const FIXTURE_TIMESTAMP = "2026-08-12T00:00:00.000Z";

/** A valid plugin manifest; override any field to probe a rejection path. */
export function fixturePluginManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "plugin_manifest",
    name: "@fixture/tool-provider",
    version: "1.0.0",
    kind: "tool",
    capabilities: ["tool.echo"],
    resources: [],
    ...overrides,
  };
}

/** A validated fixture manifest typed for SDK-facing cases. */
export function typedFixtureManifest(): PluginManifest {
  return fixturePluginManifest() as unknown as PluginManifest;
}

function repeatHex(character: string): string {
  return character.repeat(64);
}

/** A structural Task Envelope every agent adapter can be exercised with. */
export function fixtureAgentEnvelope(
  overrides: Partial<AgentTaskEnvelope> = {},
): AgentTaskEnvelope {
  return {
    task_id: "task_01",
    plan_id: "plan_01",
    iteration_id: "iteration_01",
    repository_id: "repository_01",
    objective: "Echo the fixture objective",
    expected_output: "A structured run result",
    acceptance_criteria: ["the run reports a structured result"],
    allowed_read_paths: ["src"],
    proposed_write_paths: ["src"],
    state_proposal_fields: ["summary"],
    baseline_commit: repeatHex("1"),
    input_digest: repeatHex("2"),
    digest: repeatHex("3"),
    loop_policy: { max_steps: 5, max_tokens: 10000, max_duration_ms: 60000 },
    ...overrides,
  };
}

interface FixtureNodeSpec {
  readonly id: string;
  readonly type: NodeRecord["type"];
  readonly revision?: number;
  readonly status?: NodeRecord["status"];
  readonly extensions?: Record<string, unknown>;
}

function makeNode(spec: FixtureNodeSpec): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id: spec.id,
    type: spec.type,
    revision: spec.revision ?? 1,
    status: spec.status ?? "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "conformance",
      timestamp: FIXTURE_TIMESTAMP,
    },
    confidence: 1,
  };
  if (spec.extensions !== undefined) record.extensions = spec.extensions;
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

function makeEdge(
  id: string,
  type: EdgeRecord["type"],
  sourceId: string,
  targetId: string,
): EdgeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id,
    type,
    source_id: sourceId,
    target_id: targetId,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "conformance",
      timestamp: FIXTURE_TIMESTAMP,
    },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

/**
 * A minimal graph a PRD projection can render: one intent, one requirement
 * with acceptance criteria and one constraint, plus the provenance edge.
 */
export function fixtureProjectionGraph(): ProjectionGraph {
  return {
    nodes: [
      makeNode({
        id: "intent_01",
        type: "Intent",
        extensions: { "harness.requirements": { text: "Ship the widget" } },
      }),
      makeNode({
        id: "requirement_01",
        type: "Requirement",
        extensions: {
          "harness.requirements": {
            statement: "The widget renders in under 100ms",
            acceptance: [
              { description: "render benchmark passes", verification: "gate perf_benchmark" },
            ],
          },
        },
      }),
      makeNode({
        id: "constraint_01",
        type: "Constraint",
        extensions: {
          "harness.requirements": {
            statement: "No network access from the widget",
            verification: "gate policy_check",
          },
        },
      }),
    ],
    edges: [
      makeEdge("edge_01", "DECOMPOSES_TO", "intent_01", "requirement_01"),
      makeEdge("edge_02", "CONSTRAINED_BY", "requirement_01", "constraint_01"),
    ],
  };
}

/**
 * The same graph with one requirement bumped to revision 2: projection
 * conformance uses it to prove the generation digest binds source revisions.
 */
export function fixtureProjectionGraphRevised(): ProjectionGraph {
  const graph = fixtureProjectionGraph();
  return {
    nodes: graph.nodes.map((node) =>
      node.id === "requirement_01"
        ? makeNode({
            id: "requirement_01",
            type: "Requirement",
            revision: 2,
            extensions: node.extensions as Record<string, unknown>,
          })
        : node,
    ),
    edges: graph.edges,
  };
}

/** Create a canonical (symlink-resolved) temporary directory. */
export function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function removeTempDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
