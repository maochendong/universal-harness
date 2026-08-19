import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalizeJson } from "../identity/canonical-json.js";
import { harnessRootFor, resolveHarnessPath } from "../ledger/layout.js";
import { verifyRecordEnvelope } from "../schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import type { GroundedSynthesisRecord } from "../schema/synthesis.js";

/**
 * Append-only store for grounded synthesis records. Identical re-appends are
 * idempotent no-ops; a conflicting rewrite of the same identity fails closed.
 */
export class SynthesisStoreError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "SynthesisStoreError";
    this.kind = kind;
  }
}

function assertValidRecord(record: Record<string, unknown>): void {
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("grounded-synthesis", record);
  if (!validation.valid) {
    throw new SynthesisStoreError(
      "invalid_record",
      `record failed schema validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  if (!verifyRecordEnvelope(record)) {
    throw new SynthesisStoreError("invalid_record", "record envelope digest does not verify");
  }
}

export function appendGroundedSynthesisRecord(
  projectRoot: string,
  record: GroundedSynthesisRecord,
): void {
  const asPlain = record as unknown as Record<string, unknown>;
  assertValidRecord(asPlain);
  const harnessRoot = harnessRootFor(projectRoot);
  const relativePath = `artifacts/grounded-synthesis/${record.grounded_synthesis_id}.json`;
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const content = `${canonicalizeJson(asPlain)}\n`;
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) return;
    throw new SynthesisStoreError(
      "record_conflict",
      `record already exists with different content: .harness/${relativePath}`,
    );
  }
  mkdirSync(resolveHarnessPath(harnessRoot, "artifacts/grounded-synthesis"), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

export function readGroundedSynthesisRecords(projectRoot: string): GroundedSynthesisRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, "artifacts/grounded-synthesis");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const absolute = resolveHarnessPath(harnessRoot, `artifacts/grounded-synthesis/${name}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(absolute, "utf8"));
      } catch {
        throw new SynthesisStoreError("corrupt_record", `unparseable record file: ${absolute}`);
      }
      const record = parsed as Record<string, unknown>;
      assertValidRecord(record);
      return record as unknown as GroundedSynthesisRecord;
    });
}

export function findGroundedSynthesisByConversation(
  projectRoot: string,
  conversationId: string,
): GroundedSynthesisRecord[] {
  return readGroundedSynthesisRecords(projectRoot).filter(
    (record) => record.conversation_id === conversationId,
  );
}
