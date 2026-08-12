import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LedgerRepository } from "../../src/ledger/repository.js";
import { validateSchema } from "../../src/schema/registry.js";

import { BASELINE, FIXED_NOW, makeInput, makeProjectRoot } from "./fixtures.js";

const goldenDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tests/golden/ledger",
);

function makeRepository(projectRoot: string): LedgerRepository {
  return new LedgerRepository({
    projectRoot,
    readBaseline: () => BASELINE,
    now: () => FIXED_NOW,
  });
}

describe("ledger goldens", () => {
  it("pins the committed manifest bytes for a fixed transaction", async () => {
    const repository = makeRepository(makeProjectRoot());
    const result = await repository.commit(makeInput("ledger-op_01"));
    const golden = JSON.parse(
      readFileSync(join(goldenDirectory, "commit-manifest.json"), "utf8"),
    ) as unknown;
    expect(result.status).toBe("committed");
    expect(result.manifest).toEqual(golden);
    expect(validateSchema("ledger-operation", result.manifest)).toMatchObject({ valid: true });
  });

  it("pins replay order to manifest sequence instead of directory order", async () => {
    const repository = makeRepository(makeProjectRoot());
    await repository.commit(makeInput("ledger-op_zzzz"));
    await repository.commit(makeInput("ledger-op_aaaa"));
    const replay = repository.replay();
    const golden = JSON.parse(
      readFileSync(join(goldenDirectory, "replay-order.json"), "utf8"),
    ) as unknown;
    expect({
      operations: replay.operations.map((op) => op.manifest.ledger_operation_id),
      events: replay.events.map((event) => event.event_id),
      edges: replay.edges.map((edge) => edge.id),
    }).toEqual(golden);
  });
});
