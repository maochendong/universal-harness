import { describe, expect, it } from "vitest";

import { PROTOCOL_1_3_VERSION } from "../../src/protocol.js";
import {
  SchedulingRecordError,
  assertSchedulingRecordSemantics,
  buildTaskLeaseRecord,
  buildWaveIntegrationRecord,
  type TaskLeaseRecordDraft,
  type WaveIntegrationRecordDraft,
} from "../../src/scheduling/records.js";
import {
  recordDigestOf,
  sealRecordEnvelope,
  verifyRecordEnvelope,
} from "../../src/schema/envelope.js";
import { PROTOCOL_1_3_SCHEMA_REGISTRY } from "../../src/schema/registry.js";

const digest = (char: string) => char.repeat(64);

const ISSUED_AT = "2026-08-31T00:00:00.000Z";
const EXPIRES_AT = "2026-08-31T01:00:00.000Z";
const INTEGRATED_AT = "2026-08-31T02:00:00.000Z";
const BASELINE_COMMIT = "0123456789abcdef";
const CANDIDATE_COMMIT = "fedcba9876543210";

function taskLeaseDraft(overrides?: Partial<TaskLeaseRecordDraft>): TaskLeaseRecordDraft {
  return {
    operation_id: "operation_m4_01",
    iteration_id: "iteration_m4_01",
    plan_digest: digest("a"),
    task_id: "task_api",
    task_digest: digest("b"),
    run_id: "run_m4_01",
    slot_id: "slot_01",
    baseline_commit: BASELINE_COMMIT,
    agent_adapter_digest: digest("c"),
    policy_digest: digest("d"),
    approval_digests: [digest("e")],
    task_lease_record_id: "task-lease-record_01",
    lease_id: "lease_task_api_01",
    fencing_token: 1,
    state: "granted",
    attempt_number: 1,
    reserved_budget: { steps: 40, tokens: 20000 },
    consumed_budget: { steps: 0, tokens: 0 },
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    command_id: "command_lease_grant_01",
    ...overrides,
  };
}

function waveIntegrationDraft(
  overrides?: Partial<WaveIntegrationRecordDraft>,
): WaveIntegrationRecordDraft {
  return {
    wave_integration_id: "wave-integration_01",
    operation_id: "operation_m4_01",
    iteration_id: "iteration_m4_01",
    plan_digest: digest("a"),
    wave_index: 0,
    task_ids: ["task_api", "task_ui"],
    base_commit: BASELINE_COMMIT,
    candidate_commit: CANDIDATE_COMMIT,
    accepted_source_tree_digest: digest("f"),
    task_lease_digests: [digest("1"), digest("2")],
    task_evidence_digests: [digest("3"), digest("4")],
    candidate_gate_evidence_digests: [digest("5"), digest("6")],
    wave_gate_evidence_digests: [digest("7")],
    policy_digest: digest("d"),
    approval_digests: [digest("8")],
    command_id: "command_wave_integrate_01",
    integrated_at: INTEGRATED_AT,
    ...overrides,
  };
}

describe("protocol 1.3 schema registry", () => {
  it("exposes exactly the two frozen scheduling record schemas", () => {
    expect(PROTOCOL_1_3_SCHEMA_REGISTRY.keys).toEqual(["task-lease", "wave-integration"]);
  });

  it("accepts sealed 1.3 records and rejects foreign protocol pins and unknown keys", () => {
    const lease = buildTaskLeaseRecord(taskLeaseDraft());
    const wave = buildWaveIntegrationRecord(waveIntegrationDraft());
    expect(PROTOCOL_1_3_SCHEMA_REGISTRY.validate("task-lease", lease)).toMatchObject({
      valid: true,
    });
    expect(PROTOCOL_1_3_SCHEMA_REGISTRY.validate("wave-integration", wave)).toMatchObject({
      valid: true,
    });
    expect(
      PROTOCOL_1_3_SCHEMA_REGISTRY.validate("task-lease", { ...lease, protocol_version: "1.2.0" }),
    ).toMatchObject({ valid: false });
    expect(PROTOCOL_1_3_SCHEMA_REGISTRY.validate("task-state", lease)).toMatchObject({
      valid: false,
    });
  });

  it("rejects undeclared fields on the strict schemas", () => {
    const lease = buildTaskLeaseRecord(taskLeaseDraft());
    expect(
      PROTOCOL_1_3_SCHEMA_REGISTRY.validate("task-lease", { ...lease, scheduler_state: {} }),
    ).toMatchObject({ valid: false });
  });
});

describe("buildTaskLeaseRecord", () => {
  it("seals a granted lease with the 1.3 envelope and a stable record_digest", () => {
    const granted = buildTaskLeaseRecord(taskLeaseDraft());
    expect(granted).toMatchObject({
      protocol_version: PROTOCOL_1_3_VERSION,
      record_kind: "task_lease",
      state: "granted",
      fencing_token: 1,
    });
    expect(recordDigestOf(granted)).toBe(granted.record_digest);
    expect(verifyRecordEnvelope(granted)).toBe(true);
    expect(buildTaskLeaseRecord(taskLeaseDraft()).record_digest).toBe(granted.record_digest);
  });

  it("keeps record, lease and command identities separate", () => {
    const granted = buildTaskLeaseRecord(taskLeaseDraft());
    expect(granted.task_lease_record_id).not.toBe(granted.lease_id);
    expect(granted.task_lease_record_id).not.toBe(granted.command_id);
    expect(granted.lease_id).not.toBe(granted.command_id);
  });

  it("recomputes the envelope instead of trusting caller-filled drift", () => {
    const drifted = buildTaskLeaseRecord({
      ...taskLeaseDraft(),
      protocol_version: "1.0.0",
      record_kind: "lease",
      record_digest: digest("0"),
    } as TaskLeaseRecordDraft);
    expect(drifted.protocol_version).toBe(PROTOCOL_1_3_VERSION);
    expect(drifted.record_kind).toBe("task_lease");
    expect(drifted.record_digest).toBe(recordDigestOf(drifted));
  });

  it("requires a positive integer fencing token", () => {
    for (const fencingToken of [0, -1, 1.5]) {
      expect(() => buildTaskLeaseRecord(taskLeaseDraft({ fencing_token: fencingToken }))).toThrow(
        SchedulingRecordError,
      );
    }
  });

  it("requires previous_lease_record_digest on terminal states", () => {
    for (const state of ["released", "expired", "revoked"] as const) {
      expect(() => buildTaskLeaseRecord(taskLeaseDraft({ state }))).toThrow(SchedulingRecordError);
      const terminal = buildTaskLeaseRecord(
        taskLeaseDraft({ state, previous_lease_record_digest: digest("9") }),
      );
      expect(recordDigestOf(terminal)).toBe(terminal.record_digest);
    }
  });

  it("rejects consumed budget beyond the reserved budget", () => {
    expect(() =>
      buildTaskLeaseRecord(
        taskLeaseDraft({
          reserved_budget: { steps: 40, tokens: 20000 },
          consumed_budget: { steps: 41, tokens: 20000 },
        }),
      ),
    ).toThrow(SchedulingRecordError);
    expect(() =>
      buildTaskLeaseRecord(
        taskLeaseDraft({
          reserved_budget: { steps: 40, tokens: 20000 },
          consumed_budget: { steps: 40, tokens: 20001 },
        }),
      ),
    ).toThrow(SchedulingRecordError);
    expect(
      buildTaskLeaseRecord(
        taskLeaseDraft({
          reserved_budget: { steps: 40, tokens: 20000 },
          consumed_budget: { steps: 40, tokens: 20000 },
        }),
      ).record_digest,
    ).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects duplicate approval digests and empty command ids", () => {
    expect(() =>
      buildTaskLeaseRecord(taskLeaseDraft({ approval_digests: [digest("e"), digest("e")] })),
    ).toThrow(SchedulingRecordError);
    expect(() => buildTaskLeaseRecord(taskLeaseDraft({ command_id: "" }))).toThrow(
      SchedulingRecordError,
    );
  });
});

describe("buildWaveIntegrationRecord", () => {
  it("seals a wave integration with exact Plan-ordered task ids", () => {
    const integration = buildWaveIntegrationRecord(waveIntegrationDraft());
    expect(integration).toMatchObject({
      protocol_version: PROTOCOL_1_3_VERSION,
      record_kind: "wave_integration",
      wave_index: 0,
    });
    expect(integration.task_ids).toEqual(["task_api", "task_ui"]);
    expect(integration.record_digest).toBe(recordDigestOf(integration));
    expect(verifyRecordEnvelope(integration)).toBe(true);
  });

  it("recomputes the envelope instead of trusting caller-filled drift", () => {
    const drifted = buildWaveIntegrationRecord({
      ...waveIntegrationDraft(),
      protocol_version: "1.2.0",
      record_digest: digest("0"),
    } as WaveIntegrationRecordDraft);
    expect(drifted.protocol_version).toBe(PROTOCOL_1_3_VERSION);
    expect(drifted.record_digest).toBe(recordDigestOf(drifted));
  });

  it("rejects a negative or fractional wave index", () => {
    for (const waveIndex of [-1, 0.5]) {
      expect(() =>
        buildWaveIntegrationRecord(waveIntegrationDraft({ wave_index: waveIndex })),
      ).toThrow(SchedulingRecordError);
    }
  });

  it("requires unique, non-empty task and evidence arrays", () => {
    expect(() => buildWaveIntegrationRecord(waveIntegrationDraft({ task_ids: [] }))).toThrow(
      SchedulingRecordError,
    );
    expect(() =>
      buildWaveIntegrationRecord(waveIntegrationDraft({ task_ids: ["task_api", "task_api"] })),
    ).toThrow(SchedulingRecordError);
    expect(() =>
      buildWaveIntegrationRecord(
        waveIntegrationDraft({ task_lease_digests: [digest("1"), digest("1")] }),
      ),
    ).toThrow(SchedulingRecordError);
    expect(() =>
      buildWaveIntegrationRecord(
        waveIntegrationDraft({ wave_gate_evidence_digests: [digest("7"), digest("7")] }),
      ),
    ).toThrow(SchedulingRecordError);
  });

  it("rejects an empty command id", () => {
    expect(() => buildWaveIntegrationRecord(waveIntegrationDraft({ command_id: "" }))).toThrow(
      SchedulingRecordError,
    );
  });
});

describe("assertSchedulingRecordSemantics on the read side", () => {
  it("accepts sealed records produced by the builders", () => {
    expect(() =>
      assertSchedulingRecordSemantics(buildTaskLeaseRecord(taskLeaseDraft())),
    ).not.toThrow();
    expect(() =>
      assertSchedulingRecordSemantics(buildWaveIntegrationRecord(waveIntegrationDraft())),
    ).not.toThrow();
  });

  it("fails closed on a syntactically valid but impossible lease chain", () => {
    const { previous_lease_record_digest, ...terminalWithoutLink } = buildTaskLeaseRecord(
      taskLeaseDraft({ state: "released", previous_lease_record_digest: digest("9") }),
    );
    void previous_lease_record_digest;
    const impossible = sealRecordEnvelope(terminalWithoutLink);
    expect(verifyRecordEnvelope(impossible)).toBe(true);
    expect(() => assertSchedulingRecordSemantics(impossible)).toThrow(SchedulingRecordError);
  });

  it("fails closed on consumed-over-reserved records read from disk", () => {
    const impossible = sealRecordEnvelope({
      ...buildTaskLeaseRecord(taskLeaseDraft()),
      reserved_budget: { steps: 10, tokens: 100 },
      consumed_budget: { steps: 11, tokens: 100 },
    });
    expect(() => assertSchedulingRecordSemantics(impossible)).toThrow(SchedulingRecordError);
  });

  it("rejects post-seal tampering through the envelope check", () => {
    const granted = buildTaskLeaseRecord(taskLeaseDraft());
    expect(verifyRecordEnvelope({ ...granted, fencing_token: 2 })).toBe(false);
  });
});
