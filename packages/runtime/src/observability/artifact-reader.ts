import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";

import {
  ARTIFACT_KINDS,
  harnessRootFor,
  readCommittedOperations,
  resolveHarnessPath,
  sha256Hex,
  type CommittedOperation,
  type LifecycleEvent,
} from "@universal-harness-internal/core";

import { findSecretReferences, redactSecretValues } from "../secrets/environment-reference.js";
import { ApprovalSummaryError, readApprovalSummary } from "./approval-summary.js";

/**
 * Controlled versioned artifact reading (transparency spec §9.2). One fixed
 * ArtifactKind enum, one whitelist resolution table in this module: a query
 * addresses an artifact only by its manifest-recorded byte SHA-256 (artifact
 * scope) or by a committed manifest's own digest (manifest scope for derived
 * views without an independent root artifact). Client-supplied paths are
 * never accepted and a filename is never inferred from a digest; the digest
 * is resolved against committed manifests first, then against the whitelisted
 * directories of exactly one kind.
 *
 * The approval_decision branch delegates to the shared Task 4 summary reader,
 * so there is exactly one Decision source-of-truth verification. Every view
 * is a redacted display projection (`safe_view: true`); its bytes never
 * masquerade as the original artifact, and `ref.digest` always names the
 * original committed bytes.
 */

// The kind enum lives in core (schema/event.ts) next to the ArtifactAvailable
// payload contract; this module re-exports it so readers keep one import site.
export { ARTIFACT_KINDS };

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactScope = "artifact" | "manifest";

export interface ArtifactRef {
  readonly kind: ArtifactKind;
  readonly scope: ArtifactScope;
  readonly digest: string;
}

export interface ArtifactLink {
  readonly label_zh: string;
  readonly ref: ArtifactRef;
  /** Same-origin read-only URL built from whitelisted parts only. */
  readonly href: string;
}

export interface ArtifactQuery extends ArtifactRef {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ArtifactView {
  readonly ref: ArtifactRef;
  readonly provenance: {
    readonly ledger_operation_id: string;
    readonly manifest_digest: string;
    readonly input_refs: readonly ArtifactRef[];
  };
  readonly content: unknown;
  readonly safe_view: true;
  readonly next_cursor?: string;
}

export type ArtifactReaderErrorKind =
  "invalid_artifact_query" | "artifact_not_found" | "artifact_corrupt";

export class ArtifactReaderError extends Error {
  readonly kind: ArtifactReaderErrorKind;

  constructor(kind: ArtifactReaderErrorKind, message: string) {
    super(message);
    this.name = "ArtifactReaderError";
    this.kind = kind;
  }
}

/** Display-page bounds (spec §9.2, §10). */
export const ARTIFACT_PAGE_DEFAULT_LIMIT = 20;
export const ARTIFACT_PAGE_MAX_LIMIT = 100;
export const ARTIFACT_TEXT_FRAGMENT_BYTES = 8 * 1024;
/** One serialized view never exceeds the REST response budget. */
export const ARTIFACT_VIEW_MAX_BYTES = 256 * 1024;
export const ARTIFACT_LINK_LABEL = "查看对应版本产出";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const PAYLOAD_IDENTIFIER = /^[a-z][a-z0-9-]*_[A-Za-z0-9_-]+$/u;
const MAX_LINKS_PER_EVENT = 8;

function invalidQuery(detail: string): ArtifactReaderError {
  return new ArtifactReaderError("invalid_artifact_query", detail);
}

function corrupt(detail: string): ArtifactReaderError {
  return new ArtifactReaderError("artifact_corrupt", detail);
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corrupt("the committed artifact is not a JSON object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw corrupt(`missing string field ${field}`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw corrupt(`missing boolean field ${field}`);
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw corrupt(`missing numeric field ${field}`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Strings inside collection items stay bounded; the marker keeps the cut visible. */
function itemText(value: unknown, maximum = 500): string {
  const raw = typeof value === "string" ? value : "";
  const characters = [...raw];
  return characters.length <= maximum ? raw : `${characters.slice(0, maximum - 1).join("")}…`;
}

interface OmittedField {
  readonly field: string;
  readonly reason_zh: string;
}

/**
 * Known-unsafe raw fields (transcripts, prompts, adapter proposals) are never
 * rendered; the view lists them with the reason instead of claiming to be a
 * complete log (spec §10).
 */
function omitUnsafe(
  record: Record<string, unknown>,
  fields: readonly [field: string, reason: string][],
): OmittedField[] {
  return fields
    .filter(([field]) => record[field] !== undefined)
    .map(([field, reason_zh]) => ({ field, reason_zh }));
}

interface ViewContext {
  readonly harnessRoot: string;
  readonly committing: CommittedOperation;
  /** Verified sibling records of the same manifest under one directory root. */
  readonly siblings: (relativeDirectory: string) => Record<string, unknown>[];
}

interface KindDescriptor {
  readonly kind: ArtifactKind;
  readonly scope: ArtifactScope;
  /** Whitelisted scan roots, harness-relative; kinds never share a root. */
  readonly directories: readonly string[];
  /** Kind check beyond the directory: the record must carry its real shape. */
  readonly matches: (record: Record<string, unknown>, relativePath: string) => boolean;
  /** Whitelisted business-field projection; raw fields never pass through. */
  readonly safeView: (record: Record<string, unknown>, ctx: ViewContext) => Record<string, unknown>;
  /** Collection field paged by `c:<offset>` cursors. */
  readonly pageField?: string;
  /** Long-text field fragmented by `t:<byteOffset>` cursors. */
  readonly textField?: string;
}

function nodeRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function gateExtension(record: Record<string, unknown>): Record<string, unknown> {
  const extensions = nodeRecord(record["extensions"]);
  return nodeRecord(extensions["harness.gate"]);
}

const DESCRIPTORS: Readonly<Record<ArtifactKind, KindDescriptor>> = {
  approval_decision: {
    kind: "approval_decision",
    scope: "artifact",
    directories: ["artifacts/approvals"],
    matches: (record) => record["record_kind"] === "approval_decision",
    // Never used: this kind delegates to the shared Task 4 summary reader.
    safeView: (record) => record,
  },
  prd: {
    kind: "prd",
    scope: "artifact",
    directories: ["artifacts/capture/accepted"],
    matches: (record) => record["record_kind"] === "accepted_prd",
    safeView: (record) => ({
      prd_id: text(record["prd_id"], "prd_id"),
      revision: num(record["revision"], "revision"),
      session_id: text(record["session_id"], "session_id"),
      workflow_operation_id: text(record["workflow_operation_id"], "workflow_operation_id"),
      proposal_id: text(record["proposal_id"], "proposal_id"),
      proposal_content_digest: text(record["proposal_content_digest"], "proposal_content_digest"),
      approval_digest: text(record["approval_digest"], "approval_digest"),
      requirement_baseline_digest: text(
        record["requirement_baseline_digest"],
        "requirement_baseline_digest",
      ),
      policy_digest: text(record["policy_digest"], "policy_digest"),
      ...(optionalText(record["supersedes_digest"]) === undefined
        ? {}
        : { supersedes_digest: record["supersedes_digest"] }),
      record_digest: text(record["record_digest"], "record_digest"),
    }),
  },
  design_set: {
    kind: "design_set",
    scope: "artifact",
    directories: ["artifacts/design-sets"],
    matches: (record) => record["record_kind"] === "node" && record["type"] === "DesignSet",
    safeView: (record) => {
      // Real DesignSet nodes carry the design narrative inside the
      // harness.design.set extension content (rationale); older fixtures kept
      // a top-level summary. Accept both, never fail on a missing narrative.
      const extension = nodeRecord(nodeRecord(record["extensions"])["harness.design.set"]);
      const content = nodeRecord(extension["content"]);
      return {
        design_set_id: text(record["id"], "id"),
        revision: num(record["revision"], "revision"),
        status: text(record["status"], "status"),
        summary: itemText(optionalText(record["summary"]) ?? optionalText(content["rationale"])),
        ...(typeof extension["content_digest"] === "string"
          ? { content_digest: extension["content_digest"] }
          : {}),
        ...(typeof extension["approval_digest"] === "string"
          ? { approval_digest: extension["approval_digest"] }
          : {}),
        record_digest: text(record["digest"], "digest"),
      };
    },
  },
  plan: {
    kind: "plan",
    scope: "artifact",
    directories: ["artifacts/plans"],
    matches: (record) => record["record_kind"] === "node" && record["type"] === "ExecutionPlan",
    pageField: "tasks",
    safeView: (record, ctx) => {
      // Real ExecutionPlan/Task nodes carry their narrative inside the
      // harness.plan extension (goal / objective); older fixtures kept a
      // top-level summary. Accept both, never fail on a missing narrative.
      const planExtension = nodeRecord(nodeRecord(record["extensions"])["harness.plan"]);
      const sharedContext = nodeRecord(planExtension["shared_context"]);
      const narrativeOf = (task: Record<string, unknown>): string =>
        itemText(
          optionalText(task["summary"]) ??
            optionalText(nodeRecord(nodeRecord(task["extensions"])["harness.plan"])["objective"]),
        );
      return {
        plan_id: text(record["id"], "id"),
        revision: num(record["revision"], "revision"),
        status: text(record["status"], "status"),
        summary: itemText(optionalText(record["summary"]) ?? optionalText(sharedContext["goal"])),
        ...(typeof nodeRecord(record["extensions"])["harness.plan"] === "object"
          ? { mode: optionalText(planExtension["mode"]) }
          : {}),
        record_digest: text(record["digest"], "digest"),
        tasks: {
          items: ctx.siblings("artifacts/tasks").map((task) => ({
            task_id: text(task["id"], "id"),
            summary: narrativeOf(task),
          })),
          total: 0, // replaced by the reader with the real total
        },
      };
    },
  },
  context_manifest: {
    kind: "context_manifest",
    scope: "artifact",
    directories: ["artifacts/context-bundles"],
    matches: (record) => record["record_kind"] === "context_bundle",
    safeView: (record) => {
      const extension = nodeRecord(nodeRecord(record["extensions"])["harness.context"]);
      return {
        context_bundle_id: text(record["context_bundle_id"], "context_bundle_id"),
        task_id: text(record["task_id"], "task_id"),
        stale: bool(record["stale"], "stale"),
        source_digests: stringArray(record["source_digests"]),
        record_digest: text(record["digest"], "digest"),
        ...(typeof extension["goal"] === "string" ? { goal: itemText(extension["goal"]) } : {}),
        ...(typeof extension["included_tokens"] === "number"
          ? { included_tokens: extension["included_tokens"] }
          : {}),
        ...(typeof extension["token_budget"] === "number"
          ? { token_budget: extension["token_budget"] }
          : {}),
      };
    },
  },
  run_summary: {
    kind: "run_summary",
    scope: "artifact",
    directories: ["artifacts/run-results"],
    matches: (record) =>
      typeof record["outcome"] === "string" &&
      typeof record["termination_reason"] === "string" &&
      typeof record["summary"] === "string",
    textField: "summary",
    safeView: (record) => ({
      outcome: text(record["outcome"], "outcome"),
      termination_reason: text(record["termination_reason"], "termination_reason"),
      completion_claimed: bool(record["completion_claimed"], "completion_claimed"),
      summary: text(record["summary"], "summary"),
      change_summary: nodeRecord(record["change_summary"]),
      tool_activity: {
        total_calls: num(nodeRecord(record["tool_activity"])["total_calls"] ?? 0, "total_calls"),
        governed_calls: num(
          nodeRecord(record["tool_activity"])["governed_calls"] ?? 0,
          "governed_calls",
        ),
      },
      usage: nodeRecord(record["usage"]),
      evidence: (Array.isArray(record["evidence"]) ? record["evidence"] : []).map((entry) => ({
        kind: itemText(nodeRecord(entry)["kind"], 100),
        digest: itemText(nodeRecord(entry)["digest"], 100),
      })),
      undeclared_writes: stringArray(record["undeclared_writes"]),
      omitted: omitUnsafe(record, [
        ["state_proposal", "原始适配器提案不提供展示，仅提供安全摘要"],
        ["dropped_proposal_fields", "未声明字段不提供展示，仅提供安全摘要"],
      ]),
    }),
  },
  gate_result: {
    kind: "gate_result",
    scope: "artifact",
    directories: ["artifacts/verify"],
    matches: (record) => record["record_kind"] === "orchestration_verify_result",
    pageField: "results",
    safeView: (record) => ({
      iteration_id: text(record["iteration_id"], "iteration_id"),
      completed_allowed: bool(record["completed_allowed"], "completed_allowed"),
      results: {
        items: (Array.isArray(record["results"]) ? record["results"] : []).map((entry) => ({
          gate_id: itemText(nodeRecord(entry)["gate_id"], 100),
          passed: nodeRecord(entry)["passed"] === true,
          evidence_id: itemText(nodeRecord(entry)["evidence_id"], 100),
          summary: itemText(nodeRecord(entry)["summary"]),
        })),
        total: 0,
      },
      findings: (Array.isArray(record["findings"]) ? record["findings"] : []).map((entry) => ({
        id: itemText(nodeRecord(entry)["id"], 100),
        summary: itemText(nodeRecord(entry)["summary"]),
      })),
    }),
  },
  evidence: {
    kind: "evidence",
    scope: "artifact",
    directories: ["artifacts/evidence"],
    matches: (record) => record["record_kind"] === "evidence",
    safeView: (record) => {
      const extension = gateExtension(record);
      return {
        evidence_id: text(record["evidence_id"], "evidence_id"),
        evidence_type: text(record["evidence_type"], "evidence_type"),
        subject_id: text(record["subject_id"], "subject_id"),
        record_digest: text(record["digest"], "digest"),
        provisional: bool(record["provisional"], "provisional"),
        created_at: text(record["created_at"], "created_at"),
        gate_id: itemText(extension["gate_id"], 100),
        passed: extension["passed"] === true,
        summary: itemText(extension["summary"]),
        log_summary: itemText(extension["log_summary"]),
      };
    },
  },
  evaluation: {
    kind: "evaluation",
    scope: "artifact",
    directories: ["artifacts/evaluations"],
    matches: (record) =>
      record["record_kind"] === "evidence" &&
      nodeRecord(record["extensions"])["harness.evaluation"] !== undefined,
    safeView: (record) => {
      const extension = nodeRecord(nodeRecord(record["extensions"])["harness.evaluation"]);
      return {
        evaluation_id: text(record["evidence_id"], "evidence_id"),
        subject_id: text(record["subject_id"], "subject_id"),
        record_digest: text(record["digest"], "digest"),
        created_at: text(record["created_at"], "created_at"),
        case_id: itemText(extension["case_id"], 100),
        passed: extension["passed"] === true,
        ...(typeof extension["visibility"] === "string"
          ? { visibility: extension["visibility"] }
          : {}),
      };
    },
  },
  snapshot: {
    kind: "snapshot",
    scope: "artifact",
    directories: ["artifacts/snapshots"],
    matches: (record) => record["record_kind"] === "snapshot",
    pageField: "task_verdicts",
    safeView: (record) => ({
      snapshot_id: text(record["snapshot_id"], "snapshot_id"),
      iteration_id: text(record["iteration_id"], "iteration_id"),
      status: text(record["status"], "status"),
      final_commit: text(record["final_commit"], "final_commit"),
      created_at: text(record["created_at"], "created_at"),
      run_outcomes: (Array.isArray(record["run_outcomes"]) ? record["run_outcomes"] : []).map(
        (entry) => ({
          id: itemText(nodeRecord(entry)["id"], 100),
          outcome: itemText(nodeRecord(entry)["outcome"], 100),
        }),
      ),
      task_verdicts: {
        items: (Array.isArray(record["task_verdicts"]) ? record["task_verdicts"] : []).map(
          (entry) => ({
            task_id: itemText(nodeRecord(entry)["task_id"], 100),
            verdict: itemText(nodeRecord(entry)["verdict"], 100),
          }),
        ),
        total: 0,
      },
      closed_findings: stringArray(record["closed_findings"]),
      unresolved_items: stringArray(record["unresolved_items"]).map((item) => itemText(item)),
      ...(typeof record["coverage_summary"] === "string"
        ? { coverage_summary: itemText(record["coverage_summary"]) }
        : {}),
      omitted: omitUnsafe(record, [
        ["trajectory_summary", "原始轨迹不提供展示，仅提供安全摘要"],
        ["adapter_control_profile", "适配器控制细节不提供展示"],
      ]),
    }),
  },
  tdd_artifact: {
    kind: "tdd_artifact",
    scope: "artifact",
    directories: ["artifacts/tdd-cycles"],
    matches: (record) => record["record_kind"] === "tdd_cycle",
    pageField: "evidence",
    safeView: (record, ctx) => ({
      cycle: {
        logical_cycle_id: text(record["logical_cycle_id"], "logical_cycle_id"),
        attempt_ordinal: num(record["attempt_ordinal"], "attempt_ordinal"),
        task_id: text(record["task_id"], "task_id"),
        status: text(record["status"], "status"),
        contract_digest: text(record["contract_digest"], "contract_digest"),
        record_digest: text(record["record_digest"], "record_digest"),
      },
      evidence: {
        items: ctx.siblings("artifacts/tdd-evidence").map((entry) => ({
          evidence_type: itemText(entry["evidence_type"], 100),
          digest: itemText(entry["digest"], 100),
        })),
        total: 0,
      },
      grants: ctx.siblings("artifacts/tdd-grants").map((grant) => ({
        grant_id: itemText(grant["grant_id"], 100),
        phase: itemText(grant["phase"], 100),
        digest: itemText(grant["digest"], 100),
      })),
    }),
  },
  finding_group: {
    kind: "finding_group",
    scope: "manifest",
    directories: ["artifacts/findings"],
    matches: (record) => record["record_kind"] === "feedback" && record["type"] === "Finding",
    pageField: "findings",
    // Manifest scope: the reader pages verified finding records of the
    // manifest directly; safeView is unused for this kind.
    safeView: (record) => record,
  },
  wave_result: {
    kind: "wave_result",
    scope: "artifact",
    directories: ["artifacts/scheduling"],
    matches: (record, relativePath) =>
      record["record_kind"] === "wave_integration" && relativePath.includes("/waves/"),
    safeView: (record) => ({
      wave_integration_id: text(record["wave_integration_id"], "wave_integration_id"),
      operation_id: text(record["operation_id"], "operation_id"),
      iteration_id: text(record["iteration_id"], "iteration_id"),
      wave_index: num(record["wave_index"], "wave_index"),
      task_ids: stringArray(record["task_ids"]),
      base_commit: text(record["base_commit"], "base_commit"),
      candidate_commit: text(record["candidate_commit"], "candidate_commit"),
      integrated_at: text(record["integrated_at"], "integrated_at"),
      record_digest: text(record["record_digest"], "record_digest"),
    }),
  },
  integration_record: {
    kind: "integration_record",
    scope: "artifact",
    directories: ["artifacts/integrations"],
    matches: (record) => record["record_kind"] === "integration",
    safeView: (record) => ({
      integration_id: text(record["integration_id"], "integration_id"),
      operation_id: text(record["operation_id"], "operation_id"),
      expected_target_commit: text(record["expected_target_commit"], "expected_target_commit"),
      operation_commit: text(record["operation_commit"], "operation_commit"),
      ledger_sequence_rewrites: (Array.isArray(record["ledger_sequence_rewrites"])
        ? record["ledger_sequence_rewrites"]
        : []
      ).map((rewrite) => itemText(rewrite, 100)),
      evidence_digests: stringArray(record["evidence_digests"]),
      approval_decision_digests: stringArray(record["approval_decision_digests"]),
      record_digest: text(record["record_digest"], "record_digest"),
    }),
  },
  task_lease: {
    kind: "task_lease",
    scope: "artifact",
    directories: ["artifacts/scheduling"],
    matches: (record, relativePath) =>
      record["record_kind"] === "task_lease" && relativePath.includes("/leases/"),
    safeView: (record) => ({
      task_lease_record_id: text(record["task_lease_record_id"], "task_lease_record_id"),
      lease_id: text(record["lease_id"], "lease_id"),
      operation_id: text(record["operation_id"], "operation_id"),
      task_id: text(record["task_id"], "task_id"),
      slot_id: itemText(record["slot_id"], 100),
      fencing_token: num(record["fencing_token"], "fencing_token"),
      state: text(record["state"], "state"),
      approval_digests: stringArray(record["approval_digests"]),
      record_digest: text(record["record_digest"], "record_digest"),
    }),
  },
};

/** Same-origin read-only URL built from whitelisted parts only (spec §10). */
export function artifactHref(ref: ArtifactRef): string {
  return `/api/v1/artifacts/${encodeURIComponent(ref.digest)}?kind=${encodeURIComponent(ref.kind)}&scope=${ref.scope}`;
}

/**
 * Recursive `.json` listing under one whitelisted root. Symlinks are never
 * followed, so a link inside the artifact tree can never escape the harness
 * root or alias an outside file into a digest lookup.
 */
function walkArtifactFiles(harnessRoot: string, relativeDirectory: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    let absolute: string;
    try {
      absolute = resolveHarnessPath(harnessRoot, relative);
    } catch {
      return;
    }
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${relative}/${name}`);
      return;
    }
    if (stat.isFile() && relative.endsWith(".json")) found.push(relative);
  };
  visit(relativeDirectory);
  return found;
}

interface LocatedArtifact {
  readonly relativePath: string;
  readonly bytes: string;
  readonly record: Record<string, unknown>;
}

function parseLocated(
  harnessRoot: string,
  relativePath: string,
  allowedDigests: ReadonlySet<string>,
): LocatedArtifact | undefined {
  let bytes: string;
  try {
    bytes = readFileSync(resolveHarnessPath(harnessRoot, relativePath), "utf8");
  } catch {
    return undefined;
  }
  if (!allowedDigests.has(sha256Hex(bytes))) return undefined;
  try {
    return { relativePath, bytes, record: recordOf(JSON.parse(bytes)) };
  } catch {
    return undefined;
  }
}

/** Locate the one committed artifact of `kind` whose bytes hash to `digest`. */
function locateArtifact(
  harnessRoot: string,
  descriptor: KindDescriptor,
  digest: string,
  allowedDigests: ReadonlySet<string>,
): LocatedArtifact | undefined {
  for (const directory of descriptor.directories) {
    for (const relativePath of walkArtifactFiles(harnessRoot, directory)) {
      const located = parseLocated(harnessRoot, relativePath, allowedDigests);
      if (located === undefined) continue;
      if (sha256Hex(located.bytes) !== digest) continue;
      if (!descriptor.matches(located.record, relativePath)) {
        throw corrupt(`committed artifact ${digest} does not match kind ${descriptor.kind}`);
      }
      return located;
    }
  }
  return undefined;
}

/** All artifact digests any committed manifest ever recorded. */
function committedDigestSet(operations: readonly CommittedOperation[]): Set<string> {
  const allowed = new Set<string>();
  for (const operation of operations) {
    for (const digest of operation.manifest.artifact_digests) allowed.add(digest);
  }
  return allowed;
}

function validateQuery(query: ArtifactQuery): KindDescriptor {
  if (!ARTIFACT_KINDS.includes(query.kind)) {
    throw invalidQuery(`unknown artifact kind: ${String(query.kind)}`);
  }
  const descriptor = DESCRIPTORS[query.kind];
  if (query.scope !== descriptor.scope) {
    throw invalidQuery(`kind ${query.kind} is only readable at scope=${descriptor.scope}`);
  }
  if (!DIGEST_PATTERN.test(query.digest)) {
    throw invalidQuery("artifact digest must be a lowercase SHA-256 hex string");
  }
  if (query.limit !== undefined) {
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > ARTIFACT_PAGE_MAX_LIMIT
    ) {
      throw invalidQuery(`limit must be an integer in 1..${String(ARTIFACT_PAGE_MAX_LIMIT)}`);
    }
  }
  if (query.cursor !== undefined && !/^[ct]:[0-9]+$/u.test(query.cursor)) {
    throw invalidQuery("cursor must be an opaque c:<offset> or t:<byteOffset> token");
  }
  return descriptor;
}

interface Cursor {
  readonly mode: "collection" | "text";
  readonly offset: number;
}

function parseCursor(cursor: string | undefined, descriptor: KindDescriptor): Cursor {
  if (cursor === undefined) {
    return { mode: descriptor.textField === undefined ? "collection" : "text", offset: 0 };
  }
  const [tag, raw] = cursor.split(":");
  const offset = Number.parseInt(raw ?? "", 10);
  if (tag === "t") {
    if (descriptor.textField === undefined) {
      throw invalidQuery(`kind ${descriptor.kind} has no paged text field`);
    }
    return { mode: "text", offset };
  }
  if (descriptor.pageField === undefined) {
    throw invalidQuery(`kind ${descriptor.kind} has no paged collection`);
  }
  return { mode: "collection", offset };
}

/** One UTF-8-safe fragment of at most ARTIFACT_TEXT_FRAGMENT_BYTES bytes. */
function textFragment(
  value: string,
  offsetBytes: number,
): { readonly fragment: string; readonly nextOffset?: number } {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (offsetBytes > totalBytes) throw invalidQuery("text cursor is beyond the end of the field");
  // Walk whole code points, tracking byte offsets, so a fragment never cuts a
  // multi-byte character (8 KiB UTF-8-safe paging, spec §9.2).
  let fragment = "";
  let position = 0;
  let end = totalBytes;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (position >= offsetBytes) {
      if (position + width > offsetBytes + ARTIFACT_TEXT_FRAGMENT_BYTES) {
        end = position;
        break;
      }
      fragment += character;
    }
    position += width;
  }
  return {
    fragment,
    ...(end < totalBytes ? { nextOffset: end } : {}),
  };
}

interface PagedContent {
  readonly content: Record<string, unknown>;
  readonly nextCursor?: string;
}

function pageContent(
  content: Record<string, unknown>,
  descriptor: KindDescriptor,
  query: ArtifactQuery,
): PagedContent {
  const cursor = parseCursor(query.cursor, descriptor);
  const limit = query.limit ?? ARTIFACT_PAGE_DEFAULT_LIMIT;
  if (cursor.mode === "text" && descriptor.textField !== undefined) {
    const value = content[descriptor.textField];
    if (typeof value !== "string") throw corrupt(`paged text field ${descriptor.textField}`);
    const totalBytes = Buffer.byteLength(value, "utf8");
    const { fragment, nextOffset } = textFragment(value, cursor.offset);
    return {
      content: {
        ...content,
        [descriptor.textField]: fragment,
        [`${descriptor.textField}_fragment`]: {
          truncated: nextOffset !== undefined || cursor.offset > 0,
          total_bytes: totalBytes,
        },
      },
      ...(nextOffset === undefined ? {} : { nextCursor: `t:${String(nextOffset)}` }),
    };
  }
  if (descriptor.pageField === undefined) return { content };
  const page = content[descriptor.pageField] as { items: unknown[]; total: number } | undefined;
  if (page === undefined || !Array.isArray(page.items)) {
    throw corrupt(`paged collection ${descriptor.pageField}`);
  }
  if (cursor.offset > page.items.length) {
    throw invalidQuery("collection cursor is beyond the end of the list");
  }
  const items = page.items.slice(cursor.offset, cursor.offset + limit);
  const end = cursor.offset + items.length;
  return {
    content: {
      ...content,
      [descriptor.pageField]: { items, total: page.items.length },
    },
    ...(end < page.items.length ? { nextCursor: `c:${String(end)}` } : {}),
  };
}

/** Redact every resolved env secret the raw records reference (spec §10). */
function redact(content: Record<string, unknown>, rawRecords: unknown[]): Record<string, unknown> {
  const secrets = new Map<string, string>();
  for (const raw of rawRecords) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    for (const site of findSecretReferences(raw as Record<string, unknown>)) {
      const value = process.env[site.name];
      if (value !== undefined && value !== "") secrets.set(site.name, value);
    }
  }
  return redactSecretValues(content, secrets);
}

function assertViewSize(view: ArtifactView): void {
  const bytes = Buffer.byteLength(JSON.stringify(view), "utf8");
  if (bytes > ARTIFACT_VIEW_MAX_BYTES) {
    throw corrupt(`the safe view exceeds the ${String(ARTIFACT_VIEW_MAX_BYTES)}-byte budget`);
  }
}

async function readArtifactScopeView(
  projectRoot: string,
  query: ArtifactQuery,
  descriptor: KindDescriptor,
  operations: readonly CommittedOperation[],
): Promise<ArtifactView> {
  const committing = operations
    .filter((operation) => operation.manifest.artifact_digests.includes(query.digest))
    .sort((left, right) => left.manifest.sequence - right.manifest.sequence)[0];
  if (committing === undefined) {
    throw new ArtifactReaderError(
      "artifact_not_found",
      `no committed manifest carries artifact digest ${query.digest}`,
    );
  }

  // approval_decision keeps exactly one source-of-truth verification: the
  // shared Task 4 summary reader (manifest membership, byte hash, schema and
  // path binding) instead of a second check here.
  if (descriptor.kind === "approval_decision") {
    try {
      const read = readApprovalSummary(projectRoot, query.digest);
      const manifest = operations.find(
        (operation) =>
          operation.manifest.ledger_operation_id === read.provenance.ledger_operation_id,
      );
      const view: ArtifactView = {
        ref: { kind: query.kind, scope: query.scope, digest: query.digest },
        provenance: {
          ledger_operation_id: read.provenance.ledger_operation_id,
          manifest_digest: manifest?.manifest.digest ?? "",
          input_refs: [],
        },
        content: read.summary,
        safe_view: true,
      };
      assertViewSize(view);
      return view;
    } catch (error) {
      if (error instanceof ApprovalSummaryError) {
        if (error.kind === "approval_decision_not_found") {
          throw new ArtifactReaderError("artifact_not_found", error.message);
        }
        throw corrupt(error.message);
      }
      throw error;
    }
  }

  const harnessRoot = harnessRootFor(projectRoot);
  const allowed = committedDigestSet(operations);
  const located = locateArtifact(harnessRoot, descriptor, query.digest, allowed);
  if (located === undefined) {
    throw corrupt(
      `committed artifact ${query.digest} of kind ${query.kind} is missing or unreadable`,
    );
  }
  const manifestDigests = new Set(committing.manifest.artifact_digests);
  const ctx: ViewContext = {
    harnessRoot,
    committing,
    siblings: (relativeDirectory) =>
      walkArtifactFiles(harnessRoot, relativeDirectory)
        .map((path) => parseLocated(harnessRoot, path, manifestDigests))
        .filter((entry): entry is LocatedArtifact => entry !== undefined)
        .map((entry) => entry.record),
  };
  const raw = [located.record];
  const content = redact(descriptor.safeView(located.record, ctx), raw);
  const paged = pageContent(content, descriptor, query);

  // Sibling artifacts of the same manifest that are addressable kinds become
  // input_refs, so batch views bind their complete committed input set.
  const inputRefs: ArtifactRef[] = [];
  for (const other of Object.values(DESCRIPTORS)) {
    if (other.kind === descriptor.kind || other.scope !== "artifact") continue;
    for (const directory of other.directories) {
      for (const path of walkArtifactFiles(harnessRoot, directory)) {
        const entry = parseLocated(harnessRoot, path, manifestDigests);
        if (entry === undefined || !other.matches(entry.record, path)) continue;
        inputRefs.push({ kind: other.kind, scope: "artifact", digest: sha256Hex(entry.bytes) });
      }
    }
  }
  inputRefs.sort((left, right) =>
    left.kind === right.kind
      ? left.digest.localeCompare(right.digest)
      : left.kind.localeCompare(right.kind),
  );

  const view: ArtifactView = {
    ref: { kind: query.kind, scope: query.scope, digest: query.digest },
    provenance: {
      ledger_operation_id: committing.manifest.ledger_operation_id,
      manifest_digest: committing.manifest.digest,
      input_refs: inputRefs,
    },
    content: paged.content,
    safe_view: true,
    ...(paged.nextCursor === undefined ? {} : { next_cursor: paged.nextCursor }),
  };
  assertViewSize(view);
  return view;
}

function readManifestScopeView(
  projectRoot: string,
  query: ArtifactQuery,
  descriptor: KindDescriptor,
  operations: readonly CommittedOperation[],
): ArtifactView {
  const operation = operations.find((candidate) => candidate.manifest.digest === query.digest);
  if (operation === undefined) {
    throw new ArtifactReaderError(
      "artifact_not_found",
      `no committed manifest has digest ${query.digest}`,
    );
  }
  const harnessRoot = harnessRootFor(projectRoot);
  const manifestDigests = new Set(operation.manifest.artifact_digests);
  const sources: Record<string, unknown>[] = [];
  for (const directory of descriptor.directories) {
    for (const path of walkArtifactFiles(harnessRoot, directory)) {
      const located = parseLocated(harnessRoot, path, manifestDigests);
      if (located === undefined) continue;
      if (!descriptor.matches(located.record, path)) continue;
      sources.push(located.record);
    }
  }
  sources.sort((left, right) => String(left["id"] ?? "").localeCompare(String(right["id"] ?? "")));
  const items = sources.map((record) => {
    const extension = nodeRecord(nodeRecord(record["extensions"])["harness.finding"]);
    return {
      finding_id: text(record["id"], "id"),
      status: text(record["status"], "status"),
      summary: itemText(record["summary"]),
      ...(typeof extension["rule"] === "string" ? { rule: extension["rule"] } : {}),
      ...(typeof extension["severity"] === "string" ? { severity: extension["severity"] } : {}),
    };
  });
  const paged = pageContent({ findings: { items, total: 0 } }, descriptor, query);

  // The complete committed input set: every other artifact of this manifest
  // that resolves to an addressable kind (evidence, evaluation, gate
  // results, …) is listed as an input reference.
  const inputRefs: ArtifactRef[] = [];
  for (const other of Object.values(DESCRIPTORS)) {
    if (other.kind === descriptor.kind || other.scope !== "artifact") continue;
    for (const directory of other.directories) {
      for (const path of walkArtifactFiles(harnessRoot, directory)) {
        const entry = parseLocated(harnessRoot, path, manifestDigests);
        if (entry === undefined || !other.matches(entry.record, path)) continue;
        inputRefs.push({ kind: other.kind, scope: "artifact", digest: sha256Hex(entry.bytes) });
      }
    }
  }
  inputRefs.sort((left, right) =>
    left.kind === right.kind
      ? left.digest.localeCompare(right.digest)
      : left.kind.localeCompare(right.kind),
  );

  const view: ArtifactView = {
    ref: { kind: query.kind, scope: query.scope, digest: query.digest },
    provenance: {
      ledger_operation_id: operation.manifest.ledger_operation_id,
      manifest_digest: operation.manifest.digest,
      input_refs: inputRefs,
    },
    content: redact(paged.content, sources),
    safe_view: true,
    ...(paged.nextCursor === undefined ? {} : { next_cursor: paged.nextCursor }),
  };
  assertViewSize(view);
  return view;
}

/**
 * Read the pinned safe view of one committed artifact (spec §9.2). Reading
 * never changes domain facts: every failure is a typed ArtifactReaderError.
 */
export async function readArtifactView(
  projectRoot: string,
  query: ArtifactQuery,
): Promise<ArtifactView> {
  const descriptor = validateQuery(query);
  const operations = readCommittedOperations(harnessRootFor(projectRoot));
  if (descriptor.scope === "manifest") {
    return readManifestScopeView(projectRoot, query, descriptor, operations);
  }
  return readArtifactScopeView(projectRoot, query, descriptor, operations);
}

/**
 * Rebuildable in-memory index over manifest acceptance records (spec §9.3):
 * committed operations plus a digest → kind map covering only files whose
 * bytes hash back into a committed manifest. Rebuilt whenever the committed
 * operation count changes; individual link candidates are re-verified against
 * the index, so a tampered file never produces a link.
 */
export interface ArtifactLinkResolver {
  linksForEvent(event: LifecycleEvent): readonly ArtifactLink[];
  refresh(): void;
}

interface LinkIndex {
  readonly operationCount: number;
  readonly operations: readonly CommittedOperation[];
  readonly byDigest: ReadonlyMap<string, ArtifactKind>;
}

export function createArtifactLinkResolver(projectRoot: string): ArtifactLinkResolver {
  const harnessRoot = harnessRootFor(projectRoot);
  let index: LinkIndex | undefined;

  const operationFileCount = (): number => {
    const directory = resolveHarnessPath(harnessRoot, "ledger/operations");
    if (!existsSync(directory)) return 0;
    return readdirSync(directory).filter((name) => name.endsWith(".json")).length;
  };

  const rebuild = (): LinkIndex => {
    const operations = readCommittedOperations(harnessRoot);
    const allowed = committedDigestSet(operations);
    const byDigest = new Map<string, ArtifactKind>();
    for (const descriptor of Object.values(DESCRIPTORS)) {
      if (descriptor.scope !== "artifact") continue;
      for (const directory of descriptor.directories) {
        for (const path of walkArtifactFiles(harnessRoot, directory)) {
          const located = parseLocated(harnessRoot, path, allowed);
          if (located === undefined) continue;
          if (!descriptor.matches(located.record, path)) continue;
          byDigest.set(sha256Hex(located.bytes), descriptor.kind);
        }
      }
    }
    return { operationCount: operations.length, operations, byDigest };
  };

  const current = (): LinkIndex => {
    if (index === undefined || index.operationCount !== operationFileCount()) {
      index = rebuild();
    }
    return index;
  };

  const linkFor = (kind: ArtifactKind, digest: unknown): ArtifactLink | undefined => {
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) return undefined;
    const resolved = current().byDigest.get(digest);
    if (resolved === undefined || resolved !== kind) return undefined;
    const ref: ArtifactRef = {
      kind,
      scope: DESCRIPTORS[kind].scope,
      digest,
    };
    return { label_zh: ARTIFACT_LINK_LABEL, ref, href: artifactHref(ref) };
  };

  const linkForPath = (kind: ArtifactKind, relativePath: string): ArtifactLink | undefined => {
    const descriptor = DESCRIPTORS[kind];
    const allowed = committedDigestSet(current().operations);
    const located = parseLocated(harnessRoot, relativePath, allowed);
    if (located === undefined || !descriptor.matches(located.record, relativePath)) {
      return undefined;
    }
    return linkFor(kind, sha256Hex(located.bytes));
  };

  return {
    linksForEvent(event) {
      const links: ArtifactLink[] = [];
      const seen = new Set<string>();
      const push = (link: ArtifactLink | undefined): void => {
        if (link === undefined) return;
        if (seen.has(link.ref.digest)) return;
        if (links.length >= MAX_LINKS_PER_EVENT) return;
        seen.add(link.ref.digest);
        links.push(link);
      };
      const payload =
        typeof event.payload === "object" && event.payload !== null ? event.payload : {};
      const idField = (name: string): string | undefined => {
        const value = payload[name];
        return typeof value === "string" && PAYLOAD_IDENTIFIER.test(value) ? value : undefined;
      };

      if (event.event_type === "ApprovalDecided") {
        push(linkFor("approval_decision", payload["decision_digest"]));
      }
      if (event.event_type === "ArtifactAvailable") {
        const kind = payload["artifact_kind"];
        if (
          typeof kind === "string" &&
          ARTIFACT_KINDS.includes(kind as ArtifactKind) &&
          DESCRIPTORS[kind as ArtifactKind].scope === "artifact"
        ) {
          push(linkFor(kind as ArtifactKind, payload["record_digest"]));
        }
      }
      if (event.event_type === "PlanAccepted") {
        const planId = idField("plan_id");
        if (planId !== undefined) push(linkForPath("plan", `artifacts/plans/${planId}.json`));
      }
      if (event.event_type === "ContextCompiled" || event.event_type === "BeforeContextCompile") {
        const bundleId = idField("context_bundle_id");
        if (bundleId !== undefined) {
          push(linkForPath("context_manifest", `artifacts/context-bundles/${bundleId}.json`));
        }
      }
      if (event.event_type === "IntegrationAccepted") {
        const integrationId = idField("integration_id");
        if (integrationId !== undefined) {
          push(linkForPath("integration_record", `artifacts/integrations/${integrationId}.json`));
        }
      }
      if (event.event_type === "WaveIntegrated") {
        const waveId = idField("wave_integration_id");
        if (waveId !== undefined && PAYLOAD_IDENTIFIER.test(event.workflow_operation_id)) {
          push(
            linkForPath(
              "wave_result",
              `artifacts/scheduling/${event.workflow_operation_id}/waves/${waveId}.json`,
            ),
          );
        }
      }

      // Generic same-transaction resolution: artifacts carried by the event's
      // own committed manifest need no duplicated payload reference (§9.3).
      const operation = current().operations.find(
        (candidate) => candidate.manifest.ledger_operation_id === event.ledger_operation_id,
      );
      if (operation !== undefined) {
        for (const digest of operation.manifest.artifact_digests) {
          const kind = current().byDigest.get(digest);
          if (kind === undefined) continue;
          push(linkFor(kind, digest));
        }
      }
      return links;
    },
    refresh() {
      index = undefined;
    },
  };
}
