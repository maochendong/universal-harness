import type { CollaborationConnectionRecord } from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import {
  COLLABORATION_CONTROL_REF,
  connectionIdFor,
  hasLiveLease,
  normalizeCoordinatorOrigin,
  semanticConnectionEqual,
  snapshotIdFor,
} from "../../src/collaboration/connection.js";

const digest = (letter: string): string => letter.repeat(64);

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const EARLIER = "2026-08-28T23:55:00.000Z";

function connectionRecord(
  overrides: Partial<CollaborationConnectionRecord> = {},
): CollaborationConnectionRecord {
  return {
    protocol_version: "1.2.0",
    record_kind: "collaboration_connection",
    connection_id: "connection_01",
    project_id: "project_demo",
    revision: 1,
    status: "active",
    provider: "github",
    repository_id: "acme/demo",
    canonical_remote: "https://github.com/acme/demo.git",
    canonical_remote_digest: digest("r"),
    coordinator_origin: "https://harness.example.com",
    target_ref: "refs/heads/main",
    control_ref: COLLABORATION_CONTROL_REF,
    policy_digest: digest("1"),
    actor_principal_id: "principal_alice",
    principal_snapshot_digest: digest("s"),
    command_id: "command_connect_1",
    effective_at: NOW,
    record_digest: digest("c"),
    ...overrides,
  };
}

describe("normalizeCoordinatorOrigin", () => {
  it("accepts a canonical HTTPS origin and strips a trailing slash", () => {
    expect(normalizeCoordinatorOrigin("https://harness.example.com")).toEqual({
      status: "ok",
      origin: "https://harness.example.com",
    });
    expect(normalizeCoordinatorOrigin("https://harness.example.com/")).toEqual({
      status: "ok",
      origin: "https://harness.example.com",
    });
    expect(normalizeCoordinatorOrigin("https://harness.example.com:8443")).toEqual({
      status: "ok",
      origin: "https://harness.example.com:8443",
    });
  });

  it("rejects non-HTTPS origins", () => {
    const outcome = normalizeCoordinatorOrigin("http://harness.example.com");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failure.code).toBe("invalid_coordinator_origin");
    }
  });

  it("rejects origins carrying userinfo, query, fragment or a path", () => {
    for (const origin of [
      "https://alice@harness.example.com",
      "https://alice:secret@harness.example.com",
      "https://harness.example.com?token=1",
      "https://harness.example.com#frag",
      "https://harness.example.com/api",
    ]) {
      const outcome = normalizeCoordinatorOrigin(origin);
      expect(outcome.status, origin).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.failure.code).toBe("invalid_coordinator_origin");
      }
    }
  });

  it("rejects malformed origins", () => {
    expect(normalizeCoordinatorOrigin("not-a-url").status).toBe("failed");
    expect(normalizeCoordinatorOrigin("").status).toBe("failed");
  });
});

describe("deterministic identity", () => {
  it("derives stable connection and snapshot identifiers", () => {
    expect(connectionIdFor("project_demo", "acme/demo")).toBe(
      connectionIdFor("project_demo", "acme/demo"),
    );
    expect(connectionIdFor("project_demo", "acme/demo")).toMatch(/^connection_[a-f0-9]{24}$/);
    expect(connectionIdFor("project_demo", "acme/demo")).not.toBe(
      connectionIdFor("project_demo", "acme/other"),
    );
    expect(snapshotIdFor("principal_alice", "acme/demo", NOW)).toMatch(/^snapshot_[a-f0-9]{24}$/);
    expect(snapshotIdFor("principal_alice", "acme/demo", NOW)).not.toBe(
      snapshotIdFor("principal_alice", "acme/demo", LATER),
    );
  });
});

describe("semanticConnectionEqual", () => {
  const semantics = {
    canonical_remote: "https://github.com/acme/demo.git",
    coordinator_origin: "https://harness.example.com",
    target_ref: "refs/heads/main",
    policy_digest: digest("1"),
    principal_id: "principal_alice",
  };

  it("matches an active record with identical semantics", () => {
    expect(semanticConnectionEqual(connectionRecord(), semantics)).toBe(true);
  });

  it("rejects when any semantic input drifts", () => {
    expect(
      semanticConnectionEqual(connectionRecord(), { ...semantics, target_ref: "refs/heads/dev" }),
    ).toBe(false);
    expect(
      semanticConnectionEqual(connectionRecord(), {
        ...semantics,
        coordinator_origin: "https://other.example.com",
      }),
    ).toBe(false);
    expect(
      semanticConnectionEqual(connectionRecord(), { ...semantics, policy_digest: digest("2") }),
    ).toBe(false);
    expect(
      semanticConnectionEqual(connectionRecord(), {
        ...semantics,
        principal_id: "principal_bob",
      }),
    ).toBe(false);
    expect(
      semanticConnectionEqual(connectionRecord(), {
        ...semantics,
        canonical_remote: "https://github.com/acme/other.git",
      }),
    ).toBe(false);
  });
});

describe("hasLiveLease", () => {
  const lease = (state: string, expiresAt: string) =>
    ({
      protocol_version: "1.2.0",
      record_kind: "lease",
      control_sequence: 2,
      previous_control_record_digest: digest("p"),
      lease_record_id: "lease-record_01",
      lease_id: "lease_01",
      resource_kind: "operation",
      resource_id: "operation_01",
      holder_principal_snapshot_digest: digest("s"),
      client_instance_id: "instance_01",
      fencing_token: 1,
      issued_at: NOW,
      expires_at: expiresAt,
      state,
      command_id: "command_lease_1",
      record_digest: digest("l"),
    }) as const;

  it("detects a granted or renewed lease that has not expired", () => {
    expect(hasLiveLease([lease("granted", LATER)], NOW)).toBe(true);
    expect(hasLiveLease([lease("renewed", LATER)], NOW)).toBe(true);
  });

  it("ignores expired or terminal leases and non-lease records", () => {
    expect(hasLiveLease([lease("granted", EARLIER)], NOW)).toBe(false);
    expect(hasLiveLease([lease("released", LATER)], NOW)).toBe(false);
    expect(hasLiveLease([lease("expired", LATER)], NOW)).toBe(false);
    expect(hasLiveLease([], NOW)).toBe(false);
  });
});
