import { describe, expect, it } from "vitest";

import {
  LedgerPathError,
  assertLedgerOperationId,
  assertShardMonth,
  edgeShardRelativePath,
  eventShardRelativePath,
  harnessRootFor,
  operationManifestRelativePath,
  resolveHarnessPath,
  shardMonthFor,
  stagingRelativePath,
} from "../../src/ledger/layout.js";

describe("ledger layout", () => {
  it("pins the canonical ledger paths", () => {
    expect(edgeShardRelativePath("2026-08", "ledger-op_01")).toBe(
      "ledger/edges/2026-08/ledger-op_01.jsonl",
    );
    expect(eventShardRelativePath("2026-08", "ledger-op_01")).toBe(
      "events/2026-08/ledger-op_01.jsonl",
    );
    expect(operationManifestRelativePath("ledger-op_01")).toBe(
      "ledger/operations/ledger-op_01.json",
    );
    expect(stagingRelativePath("ledger-op_01")).toBe("staging/ledger-op_01");
    expect(harnessRootFor("/repo")).toBe("/repo/.harness");
  });

  it("derives the UTC calendar month shard from ISO timestamps", () => {
    expect(shardMonthFor("2026-08-12T00:00:00.000Z")).toBe("2026-08");
    expect(shardMonthFor("2027-01-01T23:59:59.999Z")).toBe("2027-01");
    expect(() => shardMonthFor("not-a-timestamp")).toThrow(LedgerPathError);
    expect(() => assertShardMonth("2026-8")).toThrow(LedgerPathError);
  });

  it("rejects operation ids that are unsafe for file paths", () => {
    for (const id of ["Ledger-op_01", "ledger/op_01", "..", "ledger\\op_01", "x", "ledger op_01"]) {
      expect(() => assertLedgerOperationId(id), id).toThrow(LedgerPathError);
    }
    expect(() => assertLedgerOperationId("ledger-op_01K1ABCDEFGHIJKLMNOPQRST")).not.toThrow();
  });

  it("confines resolved paths to the harness root", () => {
    const root = "/repo/.harness";
    expect(resolveHarnessPath(root, "ledger/operations/ledger-op_01.json")).toBe(
      "/repo/.harness/ledger/operations/ledger-op_01.json",
    );
    for (const escape of [
      "../outside.json",
      "ledger/../../outside.json",
      "ledger//operations",
      "ledger/./operations",
      "/etc/passwd",
      "ledger\\operations",
      "",
    ]) {
      expect(() => resolveHarnessPath(root, escape), escape).toThrow(LedgerPathError);
    }
  });
});
