import {
  buildManifest,
  verifyManifestDigest,
  type LedgerOperation,
} from "@universal-harness-internal/core";
import { describe, expect, it } from "vitest";

import {
  LedgerResequenceError,
  resequenceCandidateLedger,
} from "../../src/collaboration/ledger-resequence.js";

/**
 * Deterministic candidate-only Ledger re-sequencing (design §14.2, plan M3
 * Task 6 step 2): incoming-only manifests are sorted by old sequence then id,
 * renumbered from the Target's maximum sequence + 1, and re-digested with the
 * existing `manifestDigest()`. Identical ids with different digests and any
 * relationship the function cannot explain deterministically are rejected.
 */

const BASELINE = "0123456789abcdef0123456789abcdef01234567";

function manifestAt(ledgerOperationId: string, sequence: number, salt = "00"): LedgerOperation {
  return buildManifest({
    ledger_operation_id: ledgerOperationId,
    workflow_operation_id: `workflow_op_${salt}`,
    attempt_id: `attempt_${salt}`,
    baseline_commit: BASELINE,
    sequence,
    artifact_digests: [],
    edge_file: `ledger/edges/2026-08/${ledgerOperationId}.jsonl`,
    event_file: `events/2026-08/${ledgerOperationId}.jsonl`,
    edge_file_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    event_file_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    committed_at: "2026-08-12T00:00:00.000Z",
  });
}

describe("resequenceCandidateLedger", () => {
  it("renumbers a sequence fork from the target maximum + 1 and re-digests", () => {
    const target = [manifestAt("ledger_op_t1", 1), manifestAt("ledger_op_t2", 2, "01")];
    const forked = manifestAt("ledger_op_b1", 2, "b1");

    const result = resequenceCandidateLedger({ target, incoming: [forked] });

    expect(result.manifests).toHaveLength(1);
    const resequenced = result.manifests[0] as LedgerOperation;
    expect(resequenced.sequence).toBe(3);
    expect(resequenced.ledger_operation_id).toBe("ledger_op_b1");
    expect(verifyManifestDigest(resequenced)).toBe(true);
    expect(resequenced.digest).not.toBe(forked.digest);
    // Non-sequence content is preserved byte for byte.
    expect({ ...resequenced, sequence: forked.sequence, digest: forked.digest }).toEqual(forked);
    expect(result.rewrites).toEqual([
      {
        ledger_operation_id: "ledger_op_b1",
        old_sequence: 2,
        old_manifest_digest: forked.digest,
        new_sequence: 3,
        new_manifest_digest: resequenced.digest,
      },
    ]);
  });

  it("sorts incoming-only manifests by old sequence, then ledger_operation_id", () => {
    const target = [manifestAt("ledger_op_t1", 1)];
    const incoming = [
      manifestAt("ledger_op_z", 2, "zz"),
      manifestAt("ledger_op_a", 2, "aa"),
      manifestAt("ledger_op_m", 3, "mm"),
    ];

    const result = resequenceCandidateLedger({ target, incoming });

    expect(result.manifests.map((manifest) => manifest.ledger_operation_id)).toEqual([
      "ledger_op_a",
      "ledger_op_z",
      "ledger_op_m",
    ]);
    expect(result.manifests.map((manifest) => manifest.sequence)).toEqual([2, 3, 4]);
  });

  it("starts at sequence 1 when the target ledger is empty", () => {
    const result = resequenceCandidateLedger({
      target: [],
      incoming: [manifestAt("ledger_op_a", 7, "aa")],
    });
    expect(result.manifests.map((manifest) => manifest.sequence)).toEqual([1]);
    expect(result.rewrites[0]).toMatchObject({ old_sequence: 7, new_sequence: 1 });
  });

  it("keeps already accepted operations out of the resequencing", () => {
    const accepted = manifestAt("ledger_op_t1", 1);
    const extra = manifestAt("ledger_op_b1", 2, "b1");

    const result = resequenceCandidateLedger({
      target: [accepted],
      incoming: [accepted, extra],
    });

    expect(result.manifests.map((manifest) => manifest.ledger_operation_id)).toEqual([
      "ledger_op_b1",
    ]);
    expect(result.rewrites).toEqual([]);
  });

  it("leaves an already linear incoming chain untouched", () => {
    const target = [manifestAt("ledger_op_t1", 1), manifestAt("ledger_op_t2", 2, "01")];
    const incoming = [manifestAt("ledger_op_b1", 3, "b1"), manifestAt("ledger_op_b2", 4, "b2")];

    const result = resequenceCandidateLedger({ target, incoming });

    expect(result.rewrites).toEqual([]);
    expect(result.manifests.map((manifest) => manifest.digest)).toEqual(
      incoming.map((manifest) => manifest.digest),
    );
  });

  it("rejects the same ledger_operation_id with a different digest", () => {
    const target = [manifestAt("ledger_op_x1", 1)];
    const tampered = { ...manifestAt("ledger_op_x1", 1), sequence: 5 };

    expect(() => resequenceCandidateLedger({ target, incoming: [tampered] })).toThrow(
      LedgerResequenceError,
    );
  });

  it("rejects duplicate incoming ids with different content", () => {
    const first = manifestAt("ledger_op_b1", 2, "b1");
    const second = manifestAt("ledger_op_b1", 2, "b2");

    expect(() => resequenceCandidateLedger({ target: [], incoming: [first, second] })).toThrow(
      LedgerResequenceError,
    );
  });

  it("rejects a target history that is not a single linear chain", () => {
    const target = [manifestAt("ledger_op_t1", 1), manifestAt("ledger_op_t2", 1, "01")];

    expect(() =>
      resequenceCandidateLedger({ target, incoming: [manifestAt("ledger_op_b1", 2, "b1")] }),
    ).toThrow(LedgerResequenceError);
  });

  it("rejects manifests whose recorded digest does not recompute", () => {
    const corrupt = { ...manifestAt("ledger_op_b1", 2, "b1"), digest: "f".repeat(64) };

    expect(() => resequenceCandidateLedger({ target: [], incoming: [corrupt] })).toThrow(
      LedgerResequenceError,
    );
  });
});
