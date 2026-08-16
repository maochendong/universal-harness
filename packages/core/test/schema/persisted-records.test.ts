import { describe, expect, it } from "vitest";

import {
  EDGE_STATUSES,
  FEEDBACK_TYPES,
  FEEDBACK_STATUSES,
  EVENT_TYPES,
  NODE_TYPES,
  NODE_STATUSES,
  PERSISTED_SOURCES,
  PLUGIN_KINDS,
  POLICY_MERGE_OPERATORS,
  RELATION_TYPES,
  RUN_OUTCOMES,
  TERMINATION_REASONS,
  validateSchema,
} from "../../src/schema/index.js";

const digest = "a".repeat(64);
const timestamp = "2026-08-12T00:00:00.000Z";
const provenance = {
  iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
  actor: "human:reviewer",
  timestamp,
};

function baseNode(type: string) {
  const node = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: `${type.toLowerCase()}_01K1ABCDEFGHIJKLMNO`,
    type,
    revision: 1,
    status: "accepted",
    source: "human",
    provenance,
    confidence: 1,
    digest,
    locator: "repo://repository_01/src/index.ts",
  };
  if (type === "Iteration") Object.assign(node, { iteration_state: "draft" });
  return node;
}

describe("persisted schemas", () => {
  it("covers every core node type and requires field-level policy merge operators", () => {
    for (const type of NODE_TYPES) {
      const node = baseNode(type);
      if (type === "Policy") {
        Object.assign(node, {
          policy_fields: [{ path: "limits.max_steps", merge_operator: "hard_ceiling", value: 30 }],
        });
      }
      expect(validateSchema("node", node), type).toMatchObject({ valid: true });
    }

    expect(validateSchema("node", baseNode("Policy"))).toMatchObject({ valid: false });
    expect(
      validateSchema("node", {
        ...baseNode("Iteration"),
        iteration_state: undefined,
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateSchema("node", {
        ...baseNode("Requirement"),
        iteration_state: "running",
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateSchema("node", {
        ...baseNode("Policy"),
        policy_fields: [{ path: "limits.max_steps", value: 30 }],
      }),
    ).toMatchObject({ valid: false });
  });

  it("covers relation, lifecycle event, feedback and plugin discriminators", () => {
    for (const relation of RELATION_TYPES) {
      expect(
        validateSchema("edge", {
          protocol_version: "1.0.0",
          record_kind: "edge",
          id: `edge_${relation.toLowerCase()}_01`,
          type: relation,
          source_id: "requirement_01K1ABCDEFGHIJ",
          target_id: "component_01K1ABCDEFGHIJK",
          status: "accepted",
          source: "workflow",
          provenance,
          confidence: 1,
          digest,
        }),
        relation,
      ).toMatchObject({ valid: true });
    }

    for (const eventType of EVENT_TYPES) {
      expect(
        validateSchema("event", {
          protocol_version: "1.0.0",
          record_kind: "event",
          event_id: `event_${eventType.toLowerCase()}_01`,
          event_type: eventType,
          project_id: "project_01K1ABCDEFGHIJKLMNO",
          iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
          workflow_operation_id: "workflow_01K1ABCDEFGHIJKLMNOPQ",
          ledger_operation_id: "ledger_01K1ABCDEFGHIJKLMNOPQRST",
          sequence: 1,
          timestamp,
          payload: {},
        }),
        eventType,
      ).toMatchObject({ valid: true });
    }

    for (const type of FEEDBACK_TYPES) {
      expect(
        validateSchema("feedback", {
          protocol_version: "1.0.0",
          record_kind: "feedback",
          id: `feedback_${type.toLowerCase()}_01`,
          type,
          iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
          status: "proposed",
          summary: `${type} summary`,
          created_at: timestamp,
          digest,
        }),
        type,
      ).toMatchObject({ valid: true });
    }

    for (const kind of PLUGIN_KINDS) {
      expect(
        validateSchema("plugin", {
          protocol_version: "1.0.0",
          record_kind: "plugin_manifest",
          name: `example-${kind}`,
          version: "1.2.3",
          kind,
          capabilities: ["read_repository"],
          resources: ["repo://repository_01/**"],
        }),
        kind,
      ).toMatchObject({ valid: true });
    }
  });

  it("covers every node status, run outcome and termination reason", () => {
    for (const status of NODE_STATUSES) {
      expect(validateSchema("node", { ...baseNode("Requirement"), status }), status).toMatchObject({
        valid: true,
      });
    }
    for (const status of EDGE_STATUSES) {
      expect(
        validateSchema("edge", {
          protocol_version: "1.0.0",
          record_kind: "edge",
          id: `edge_status_${status}`,
          type: "ADDRESSES",
          source_id: "decision_01K1ABCDEFGHIJKLMNO",
          target_id: "requirement_01K1ABCDEFGHIJKLMN",
          status,
          source: "workflow",
          provenance,
          confidence: 1,
          digest,
        }),
        status,
      ).toMatchObject({ valid: true });
    }
    for (const status of FEEDBACK_STATUSES) {
      expect(
        validateSchema("feedback", {
          protocol_version: "1.0.0",
          record_kind: "feedback",
          id: `feedback_status_${status}`,
          type: "Finding",
          iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
          status,
          summary: "finding summary",
          created_at: timestamp,
          digest,
        }),
        status,
      ).toMatchObject({ valid: true });
    }
    for (const source of PERSISTED_SOURCES) {
      expect(validateSchema("node", { ...baseNode("Requirement"), source }), source).toMatchObject({
        valid: true,
      });
    }
    for (const mergeOperator of POLICY_MERGE_OPERATORS) {
      expect(
        validateSchema("node", {
          ...baseNode("Policy"),
          policy_fields: [{ path: "limits.max_steps", merge_operator: mergeOperator, value: 30 }],
        }),
        mergeOperator,
      ).toMatchObject({ valid: true });
    }
    for (const outcome of RUN_OUTCOMES) {
      for (const terminationReason of TERMINATION_REASONS) {
        expect(
          validateSchema("runtime", {
            protocol_version: "1.0.0",
            record_kind: "run_terminated",
            run_id: "run_01K1ABCDEFGHIJKLMNOPQRSTUV",
            task_id: "task_01K1ABCDEFGHIJKLMNOPQRSTU",
            workflow_operation_id: "workflow_01K1ABCDEFGHIJKLMNOPQ",
            attempt_id: "attempt_01K1ABCDEFGHIJKLMNOPQRST",
            sequence: 2,
            timestamp,
            outcome,
            termination_reason: terminationReason,
          }),
          `${outcome}/${terminationReason}`,
        ).toMatchObject({ valid: true });
      }
    }
  });

  it("accepts a human-reviewed may-impact relation", () => {
    expect(
      validateSchema("edge", {
        protocol_version: "1.0.0",
        record_kind: "edge",
        id: "edge_may-impact_01",
        type: "MAY_IMPACT",
        source_id: "requirement_01K1ABCDEFGHIJ",
        target_id: "component_01K1ABCDEFGHIJK",
        status: "accepted",
        source: "human",
        provenance,
        confidence: 1,
        digest,
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects unknown fields and only permits namespaced extensions", () => {
    expect(validateSchema("node", { ...baseNode("Requirement"), unexpected: true })).toMatchObject({
      valid: false,
    });
    expect(
      validateSchema("node", {
        ...baseNode("Requirement"),
        extensions: { "example.future": { future_field: true } },
      }),
    ).toMatchObject({ valid: true });
    expect(
      validateSchema("node", {
        ...baseNode("Requirement"),
        extensions: { future: { future_field: true } },
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateSchema("node", { ...baseNode("Requirement"), protocol_version: "2.0.0" }),
    ).toMatchObject({ valid: false });
  });
});
