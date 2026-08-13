import {
  PROTOCOL_VERSION,
  contentDigest,
  type EdgeRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";

import type { BundleBindings, ContextCandidate } from "../../src/context/compiler.js";
import type { SourceTier } from "../../src/context/selector.js";

export const FIXED_NOW = "2026-08-12T00:00:00.000Z";

export const BINDINGS: BundleBindings = {
  requirement_baseline_digest: "a".repeat(64),
  policy_digest: "b".repeat(64),
  plan_digest: "c".repeat(64),
  approval_digests: ["d".repeat(64)],
};

export function makeNode(id: string, type: NodeRecord["type"], revision = 1): NodeRecord {
  const record: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id,
    type,
    revision,
    status: "accepted",
    source: "human",
    provenance: { iteration_id: "iteration_01", actor: "context-test", timestamp: FIXED_NOW },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

export function makeEdge(
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
    source: "human",
    provenance: { iteration_id: "iteration_01", actor: "context-test", timestamp: FIXED_NOW },
    confidence: 1,
  };
  return { ...record, digest: contentDigest(record) } as unknown as EdgeRecord;
}

export function candidate(
  id: string,
  type: NodeRecord["type"],
  tier: SourceTier,
  content: string,
  overrides?: Partial<Pick<ContextCandidate, "reason" | "protectedFields" | "sensitive">>,
): ContextCandidate {
  const base: ContextCandidate = {
    node: makeNode(id, type),
    content,
    tier,
    reason: `reason for ${id}`,
  };
  return { ...base, ...overrides };
}
