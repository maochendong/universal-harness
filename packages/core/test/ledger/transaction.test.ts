import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/ledger/event-store.js";
import {
  buildManifest,
  manifestDigest,
  validateTransaction,
  verifyManifestDigest,
  type ManifestDraft,
} from "../../src/ledger/transaction.js";
import { validateSchema } from "../../src/schema/registry.js";

import { BASELINE, FIXED_MONTH, FIXED_NOW, makeEdge, makeEvent, makeInput } from "./fixtures.js";

function makeDraft(overrides?: Partial<ManifestDraft>): ManifestDraft {
  return {
    ledger_operation_id: "ledger-op_01",
    workflow_operation_id: "workflow-op_01",
    attempt_id: "attempt_01",
    baseline_commit: BASELINE,
    sequence: 1,
    artifact_digests: [sha256Hex('{"decision":"keep"}\n')],
    edge_file: `ledger/edges/${FIXED_MONTH}/ledger-op_01.jsonl`,
    event_file: `events/${FIXED_MONTH}/ledger-op_01.jsonl`,
    edge_file_digest: sha256Hex("edges"),
    event_file_digest: sha256Hex("events"),
    committed_at: FIXED_NOW,
    ...overrides,
  };
}

describe("transaction manifest", () => {
  it("builds a schema-valid ledger operation manifest", () => {
    const manifest = buildManifest(makeDraft());
    expect(validateSchema("ledger-operation", manifest)).toMatchObject({ valid: true });
  });

  it("keeps the digest stable across commit wall-clock time", () => {
    const early = manifestDigest(makeDraft({ committed_at: "2026-08-12T00:00:00.000Z" }));
    const late = manifestDigest(makeDraft({ committed_at: "2027-03-01T12:34:56.000Z" }));
    expect(early).toBe(late);
  });

  it("changes the digest when any content field changes", () => {
    const base = manifestDigest(makeDraft());
    expect(manifestDigest(makeDraft({ sequence: 2 }))).not.toBe(base);
    expect(manifestDigest(makeDraft({ baseline_commit: "fedcba9876543210" }))).not.toBe(base);
    expect(manifestDigest(makeDraft({ attempt_id: "attempt_02" }))).not.toBe(base);
  });

  it("verifies the digest of a committed manifest and detects tampering", () => {
    const manifest = buildManifest(makeDraft());
    expect(verifyManifestDigest(manifest)).toBe(true);
    expect(verifyManifestDigest({ ...manifest, sequence: 99 })).toBe(false);
    expect(verifyManifestDigest({ ...manifest, committed_at: "2027-01-01T00:00:00.000Z" })).toBe(
      true,
    );
  });
});

describe("transaction validation", () => {
  it("accepts a well-formed transaction", () => {
    expect(validateTransaction(makeInput("ledger-op_01"))).toEqual([]);
  });

  it("reports schema violations with the precise record location", () => {
    const badEdge = { ...makeEdge("edge_01"), bogus: true } as never;
    const issues = validateTransaction(makeInput("ledger-op_01", { edges: [badEdge] }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.instancePath).toMatch(/^\/edges\/0/u);
  });

  it("rejects events bound to another ledger or workflow operation", () => {
    const stray = makeEvent("event_01", "ledger-op_OTHER", 1);
    const issues = validateTransaction(makeInput("ledger-op_01", { events: [stray] }));
    expect(issues.map((issue) => issue.keyword)).toContain("operationBinding");
    const strayWorkflow = { ...makeEvent("event_01", "ledger-op_01", 1) };
    (strayWorkflow as { workflow_operation_id: string }).workflow_operation_id = "workflow-op_99";
    const workflowIssues = validateTransaction(
      makeInput("ledger-op_01", { events: [strayWorkflow] }),
    );
    expect(workflowIssues.map((issue) => issue.keyword)).toContain("operationBinding");
  });

  it("rejects artifact paths that are reserved, traversing or duplicated", () => {
    const reserved = validateTransaction(
      makeInput("ledger-op_01", {
        artifacts: [{ path: "ledger/operations/ledger-op_01.json", content: "{}" }],
      }),
    );
    expect(reserved.map((issue) => issue.keyword)).toContain("reservedPrefix");

    const traversal = validateTransaction(
      makeInput("ledger-op_01", { artifacts: [{ path: "../escape.json", content: "{}" }] }),
    );
    expect(traversal.map((issue) => issue.keyword)).toContain("pattern");

    const duplicate = validateTransaction(
      makeInput("ledger-op_01", {
        artifacts: [
          { path: "nodes/a.json", content: "{}" },
          { path: "nodes/a.json", content: "{}" },
        ],
      }),
    );
    expect(duplicate.map((issue) => issue.keyword)).toContain("uniqueItems");
  });
});
