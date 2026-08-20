import { existsSync, readdirSync, readFileSync } from "node:fs";

import { harnessRootFor, resolveHarnessPath } from "../ledger/layout.js";
import { verifyRecordEnvelope } from "../schema/envelope.js";
import { validateSchema } from "../schema/registry.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import type { AcceptedPrdRecord, RequirementBaselineRecord } from "../schema/acceptance.js";
import type { NodeRecord } from "../schema/node.js";

/**
 * Read side of the accepted transaction artifacts (design 7.5). Accepted PRD
 * records, requirement baselines and graph nodes land as Ledger artifacts in
 * the atomic commit; these readers validate every byte against the domain
 * schemas before returning it, so a tampered artifact fails closed instead of
 * feeding downstream compilation.
 */
export class AcceptanceStoreError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "AcceptanceStoreError";
    this.kind = kind;
  }
}

function readJsonFile(absolute: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new AcceptanceStoreError("corrupt_record", `unparseable record file: ${absolute}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AcceptanceStoreError("corrupt_record", `record file is not an object: ${absolute}`);
  }
  return parsed as Record<string, unknown>;
}

function assertDomainRecord(
  schemaKey: "accepted-prd" | "requirement-baseline",
  record: Record<string, unknown>,
): void {
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(schemaKey, record);
  if (!validation.valid || !verifyRecordEnvelope(record)) {
    throw new AcceptanceStoreError(
      "corrupt_record",
      `accepted artifact failed validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
}

function listFiles(root: string, relative: string): string[] {
  const directory = resolveHarnessPath(root, relative);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

/** All committed accepted PRD records, optionally narrowed to one prd_id. */
export function readAcceptedPrdRecords(projectRoot: string, prdId?: string): AcceptedPrdRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const base = resolveHarnessPath(harnessRoot, "artifacts/capture/accepted");
  if (!existsSync(base)) return [];
  const records: AcceptedPrdRecord[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (prdId !== undefined && entry.name !== prdId) continue;
    for (const name of listFiles(harnessRoot, `artifacts/capture/accepted/${entry.name}`).filter(
      (fileName) => /^[0-9]+\.json$/u.test(fileName),
    )) {
      const record = readJsonFile(
        resolveHarnessPath(harnessRoot, `artifacts/capture/accepted/${entry.name}/${name}`),
      );
      assertDomainRecord("accepted-prd", record);
      records.push(record as unknown as AcceptedPrdRecord);
    }
  }
  return records.sort((left, right) => left.revision - right.revision);
}

/** All committed requirement baselines for one session. */
export function readRequirementBaselineRecords(
  projectRoot: string,
  sessionId: string,
): RequirementBaselineRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const base = resolveHarnessPath(harnessRoot, "artifacts/capture/accepted");
  if (!existsSync(base)) return [];
  const records: RequirementBaselineRecord[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of listFiles(harnessRoot, `artifacts/capture/accepted/${entry.name}`).filter(
      (fileName) => /^baseline-[0-9]+\.json$/u.test(fileName),
    )) {
      const record = readJsonFile(
        resolveHarnessPath(harnessRoot, `artifacts/capture/accepted/${entry.name}/${name}`),
      );
      assertDomainRecord("requirement-baseline", record);
      if (record["session_id"] === sessionId) {
        records.push(record as unknown as RequirementBaselineRecord);
      }
    }
  }
  return records.sort((left, right) => left.prd_revision - right.prd_revision);
}

const NODE_DIRECTORIES = [
  "artifacts/intents",
  "artifacts/requirements",
  "artifacts/constraints",
  "artifacts/tests",
] as const;

/**
 * Latest committed revision per node id across the accepted graph artifact
 * directories. Only schema-valid node records participate; a corrupt artifact
 * fails closed.
 */
export function readAcceptedGraphNodes(projectRoot: string): Map<string, NodeRecord> {
  const harnessRoot = harnessRootFor(projectRoot);
  const byId = new Map<string, NodeRecord>();
  for (const directory of NODE_DIRECTORIES) {
    const base = resolveHarnessPath(harnessRoot, directory);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of listFiles(harnessRoot, `${directory}/${entry.name}`)) {
        const absolute = resolveHarnessPath(harnessRoot, `${directory}/${entry.name}/${name}`);
        const record = readJsonFile(absolute);
        if (record["record_kind"] !== "node") continue;
        const validation = validateSchema("node", record);
        if (!validation.valid) {
          throw new AcceptanceStoreError(
            "corrupt_record",
            `node artifact failed validation: ${absolute}`,
          );
        }
        const node = record as unknown as NodeRecord;
        const current = byId.get(node.id);
        if (
          current !== undefined &&
          current.revision === node.revision &&
          current.digest !== node.digest
        ) {
          throw new AcceptanceStoreError(
            "record_conflict",
            `revision fork for node ${node.id} at revision ${String(node.revision)}`,
          );
        }
        if (current === undefined || node.revision > current.revision) {
          byId.set(node.id, node);
        }
      }
    }
  }
  return byId;
}
