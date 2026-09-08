import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCommittedOperation,
  readCommittedEventShard,
  replayLedger,
  sha256Hex,
} from "../../src/ledger/event-store.js";
import { LedgerRepository } from "../../src/ledger/repository.js";
import { buildManifest, LedgerCorruptionError } from "../../src/ledger/transaction.js";
import { BASELINE, FIXED_NOW, makeInput, makeProjectRoot } from "./fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(patch: Record<string, unknown> = {}) {
  const root = makeProjectRoot();
  roots.push(root);
  const repository = new LedgerRepository({
    projectRoot: root,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
  });
  await repository.commit(makeInput("ledger_observer"));
  const operation = readCommittedOperation(repository.harnessRoot, "ledger_observer.json");
  const path = join(repository.harnessRoot, operation.manifest.event_file);
  const event = { ...JSON.parse(readFileSync(path, "utf8")), ...patch };
  const bytes = `${JSON.stringify(event)}\n`;
  const { digest, protocol_version, record_kind, ...draft } = operation.manifest;
  void digest;
  void protocol_version;
  void record_kind;
  const manifest = buildManifest({ ...draft, event_file_digest: sha256Hex(bytes) });
  writeFileSync(path, bytes);
  writeFileSync(operation.manifestPath, `${JSON.stringify(manifest)}\n`);
  const committed = readCommittedOperation(repository.harnessRoot, "ledger_observer.json");
  return { root: repository.harnessRoot, path, operation: committed };
}

describe("committed observer validation", () => {
  it("skips an unknown discriminator only for observers, keeping strict replay closed", async () => {
    const data = await fixture({ event_type: "FutureEvent" });
    expect(
      readCommittedEventShard(data.root, data.operation, { unknownEventTypes: "skip" }),
    ).toEqual([]);
    expect(() => replayLedger(data.root)).toThrow(LedgerCorruptionError);
  });

  it.each([
    { event_type: "FutureEvent", timestamp: "not-a-date" },
    { event_type: "FutureEvent", sequence: 0 },
    { event_type: "" },
    { event_type: "FutureEvent", workflow_operation_id: "workflow_unrelated" },
    { ledger_operation_id: "ledger_other" },
    { payload: null },
  ])(
    "rejects invalid envelopes or manifest bindings despite a matching digest: %j",
    async (patch) => {
      const data = await fixture(patch);
      expect(() =>
        readCommittedEventShard(data.root, data.operation, { unknownEventTypes: "skip" }),
      ).toThrow(LedgerCorruptionError);
    },
  );

  it("blocks a missing committed shard", async () => {
    const data = await fixture();
    rmSync(data.path);
    expect(() => readCommittedEventShard(data.root, data.operation)).toThrow("missing shard");
  });

  it("blocks a bad digest instead of returning a partial event page", async () => {
    const data = await fixture();
    writeFileSync(data.path, "{}\n");
    expect(() => readCommittedEventShard(data.root, data.operation)).toThrow("digest mismatch");
  });
});
