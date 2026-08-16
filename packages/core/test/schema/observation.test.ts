import { describe, expect, it } from "vitest";

import { validateSchema } from "../../src/schema/index.js";

describe("observation event schema", () => {
  it("accepts a live phase event without pretending it is a ledger record", () => {
    const observation = {
      stream_version: 1,
      stream_id: "stream_workflow-01_attempt-01",
      sequence: 1,
      observation_key: "phase_workflow-01_capture_started",
      event_type: "PhaseStarted",
      project_id: "project_01K1ABCDEFGHIJKLMNO",
      iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
      workflow_operation_id: "workflow_01K1ABCDEFGHIJKLMNOPQ",
      timestamp: "2026-08-16T00:00:00.000Z",
      payload: { phase: "capture" },
    };

    expect(validateSchema("observation", observation)).toEqual({ valid: true, errors: [] });
    expect(observation).not.toHaveProperty("protocol_version");
    expect(observation).not.toHaveProperty("ledger_operation_id");
  });

  it("accepts committed finding lifecycle events as ledger records", () => {
    for (const eventType of ["FindingAccepted", "FindingClosed", "FindingSuperseded"]) {
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
          timestamp: "2026-08-16T00:00:00.000Z",
          payload: { finding_id: "finding_01K1ABCDEFGHIJKLMNO" },
        }),
        eventType,
      ).toEqual({ valid: true, errors: [] });
    }
  });

  it("rejects stream coordinates that cannot be used as stable identifiers", () => {
    expect(
      validateSchema("observation", {
        stream_version: 1,
        stream_id: "workflow 01 / attempt 01",
        sequence: 1,
        observation_key: "phase capture started",
        event_type: "PhaseStarted",
        project_id: "project_01K1ABCDEFGHIJKLMNO",
        iteration_id: "iteration_01K1ABCDEFGHIJKLMNO",
        workflow_operation_id: "workflow_01K1ABCDEFGHIJKLMNOPQ",
        timestamp: "2026-08-16T00:00:00.000Z",
        payload: {},
      }),
    ).toMatchObject({ valid: false });
  });
});
