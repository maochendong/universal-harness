import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalizeJson } from "../identity/canonical-json.js";
import { harnessRootFor, resolveHarnessPath } from "../ledger/layout.js";
import { verifyRecordEnvelope } from "../schema/envelope.js";
import type { CaptureRiskAssessmentRecord } from "../schema/risk.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";

/**
 * Append-only store for capture risk assessment records (design 6.7; same
 * conventions as the proposal/review stores). Identical re-appends are
 * idempotent no-ops; divergent rewrites of a committed identity fail closed.
 */
export class RiskStoreError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "RiskStoreError";
    this.kind = kind;
  }
}

function assertValidRecord(record: Record<string, unknown>): void {
  if (record["record_kind"] !== "capture_risk_assessment") {
    throw new RiskStoreError(
      "invalid_record",
      `unknown record kind: ${String(record["record_kind"])}`,
    );
  }
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("capture-risk-assessment", record);
  if (!validation.valid) {
    throw new RiskStoreError(
      "invalid_record",
      `record failed schema validation: ${validation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  if (!verifyRecordEnvelope(record)) {
    throw new RiskStoreError("invalid_record", "record envelope digest does not verify");
  }
}

export function appendCaptureRiskAssessmentRecord(
  projectRoot: string,
  record: CaptureRiskAssessmentRecord,
): void {
  assertValidRecord(record as unknown as Record<string, unknown>);
  const harnessRoot = harnessRootFor(projectRoot);
  const relativePath = `artifacts/capture/risk/${record.session_id}/${record.risk_assessment_id}.json`;
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const content = `${canonicalizeJson(record)}\n`;
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) return;
    throw new RiskStoreError(
      "record_conflict",
      `record already exists with different content: .harness/${relativePath}`,
    );
  }
  mkdirSync(resolveHarnessPath(harnessRoot, `artifacts/capture/risk/${record.session_id}`), {
    recursive: true,
  });
  writeFileSync(absolute, content, "utf8");
}

export function readCaptureRiskAssessments(
  projectRoot: string,
  sessionId: string,
): CaptureRiskAssessmentRecord[] {
  const harnessRoot = harnessRootFor(projectRoot);
  const directory = resolveHarnessPath(harnessRoot, `artifacts/capture/risk/${sessionId}`);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const absolute = resolveHarnessPath(
        harnessRoot,
        `artifacts/capture/risk/${sessionId}/${name}`,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(absolute, "utf8"));
      } catch {
        throw new RiskStoreError("corrupt_record", `unparseable record file: ${absolute}`);
      }
      const record = parsed as Record<string, unknown>;
      assertValidRecord(record);
      return record as unknown as CaptureRiskAssessmentRecord;
    });
}
