import { contentDigest } from "@universal-harness-internal/core";

import { ToolError } from "../tools/definition.js";
import { invokeTool, type ToolInvocationContext } from "../tools/invocation.js";
import type { ToolRegistry } from "../tools/registry.js";

/**
 * GateProvider (design 13.6). A gate is a deterministic verification command
 * -- test, lint, build, security or project-specific -- declared as data and
 * executed exclusively through the Tool Registry: the provider builds a
 * normal `ToolInvocationRequest` and calls `invokeTool`, so every gate run
 * gets the same schema, phase, resource, grant, approval, quota, timeout and
 * redaction enforcement as any other governed capability. The provider never
 * spawns a subprocess itself; the registered tool handler owns execution.
 *
 * The provider normalizes exit code, structured result, log summary and
 * artifact hashes into a `GateOutcome`. It reports what happened; whether a
 * result permits release is a policy decision made elsewhere (design 13.6).
 */
export const GATE_LAYERS = ["universal", "stack", "project"] as const;

export type GateLayer = (typeof GATE_LAYERS)[number];

/** Phase every gate tool must grant; gates run in verification, never earlier. */
export const GATE_PHASE = "verification" as const;

export const GATE_ERROR_KINDS = [
  "invalid_gate_definition",
  "invalid_evidence_record",
  "invalid_finding_record",
] as const;

export type GateErrorKind = (typeof GATE_ERROR_KINDS)[number];

export class GateError extends Error {
  readonly kind: GateErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: GateErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GateError";
    this.kind = kind;
    if (details !== undefined) this.details = details;
  }
}

const GATE_ID_PATTERN = /^gate_[A-Za-z0-9_-]{1,150}$/u;

/** Same shape as the core IdentifierSchema: subjects are ledger node ids. */
const SUBJECT_ID_PATTERN = /^[a-z][a-z0-9-]*_[A-Za-z0-9_-]{1,150}$/u;

/**
 * Immutable gate declaration. `tool` names a registered ToolDefinition whose
 * handler performs the actual command; the descriptor digest identifies the
 * exact gate the produced evidence binds.
 */
export interface GateDefinition {
  readonly gate_id: string;
  readonly layer: GateLayer;
  readonly name: string;
  /** Mandatory gates block `completed` and create a Finding on failure. */
  readonly mandatory: boolean;
  /** Node the gate verifies (Test, Requirement, EvaluationCase, ...). */
  readonly subject_id: string;
  readonly tool: string;
  readonly version?: string;
  readonly parameters: Record<string, unknown>;
  readonly resource?: string;
  readonly digest: string;
}

/**
 * Normalized gate result. `exit_code` is null only when the invocation itself
 * failed before producing one (unknown tool, quota, timeout, ...); such
 * failures always fail the gate and carry the ToolError kind in `error`.
 */
export interface GateOutcome {
  readonly gate_id: string;
  readonly layer: GateLayer;
  readonly mandatory: boolean;
  readonly subject_id: string;
  readonly passed: boolean;
  readonly exit_code: number | null;
  readonly summary: string;
  readonly log_summary: string;
  readonly artifact_hashes: Readonly<Record<string, string>>;
  readonly output_digest: string;
  readonly error?: string;
  /** Producer-specific, schema-keyed evidence metadata already stripped of secrets. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

function invalid(message: string): GateError {
  return new GateError("invalid_gate_definition", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate and normalize a raw gate declaration. Structural violations throw
 * a typed invalid_gate_definition error before the gate can ever run.
 */
export function normalizeGateDefinition(raw: unknown): GateDefinition {
  if (!isPlainObject(raw)) {
    throw invalid("a gate definition must be an object");
  }
  if (typeof raw.gate_id !== "string" || !GATE_ID_PATTERN.test(raw.gate_id)) {
    throw invalid(`gate definition gate_id must match ${GATE_ID_PATTERN.source}`);
  }
  if (typeof raw.layer !== "string" || !GATE_LAYERS.includes(raw.layer as GateLayer)) {
    throw invalid(`gate definition layer must be one of ${GATE_LAYERS.join(", ")}`);
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw invalid("gate definition name must be a non-empty string");
  }
  if (typeof raw.subject_id !== "string" || !SUBJECT_ID_PATTERN.test(raw.subject_id)) {
    throw invalid(`gate definition subject_id must match ${SUBJECT_ID_PATTERN.source}`);
  }
  if (typeof raw.tool !== "string" || raw.tool.trim() === "") {
    throw invalid("gate definition tool must name a registered tool");
  }
  if (raw.version !== undefined && typeof raw.version !== "string") {
    throw invalid("gate definition version must be a string when present");
  }
  if (raw.resource !== undefined && typeof raw.resource !== "string") {
    throw invalid("gate definition resource must be a string when present");
  }
  if (raw.parameters !== undefined && !isPlainObject(raw.parameters)) {
    throw invalid("gate definition parameters must be an object");
  }
  const definition: Omit<GateDefinition, "digest"> = {
    gate_id: raw.gate_id,
    layer: raw.layer as GateLayer,
    name: raw.name,
    mandatory: raw.mandatory === true,
    subject_id: raw.subject_id,
    tool: raw.tool,
    ...(raw.version === undefined ? {} : { version: raw.version }),
    parameters: raw.parameters === undefined ? {} : raw.parameters,
    ...(raw.resource === undefined ? {} : { resource: raw.resource }),
  };
  return { ...definition, digest: contentDigest(definition) };
}

function readArtifactHashes(value: unknown): Readonly<Record<string, string>> {
  if (!isPlainObject(value)) return {};
  const hashes: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value)) {
    if (typeof hash === "string") hashes[path] = hash;
  }
  return hashes;
}

function outcomeOf(
  gate: GateDefinition,
  fields: {
    readonly passed: boolean;
    readonly exit_code: number | null;
    readonly summary: string;
    readonly log_summary: string;
    readonly artifact_hashes: Readonly<Record<string, string>>;
    readonly error?: string;
    readonly extensions?: Readonly<Record<string, unknown>>;
  },
): GateOutcome {
  const outcome: GateOutcome = {
    gate_id: gate.gate_id,
    layer: gate.layer,
    mandatory: gate.mandatory,
    subject_id: gate.subject_id,
    passed: fields.passed,
    exit_code: fields.exit_code,
    summary: fields.summary,
    log_summary: fields.log_summary,
    artifact_hashes: fields.artifact_hashes,
    output_digest: contentDigest({
      gate_id: gate.gate_id,
      passed: fields.passed,
      exit_code: fields.exit_code,
      summary: fields.summary,
      log_summary: fields.log_summary,
      artifact_hashes: fields.artifact_hashes,
      ...(fields.error === undefined ? {} : { error: fields.error }),
      ...(fields.extensions === undefined ? {} : { extensions: fields.extensions }),
    }),
    ...(fields.error === undefined ? {} : { error: fields.error }),
    ...(fields.extensions === undefined ? {} : { extensions: fields.extensions }),
  };
  return outcome;
}

export interface GateRunOptions {
  /** Caller-minted stable id, unique per logical gate invocation. */
  readonly intentId: string;
  /** Invocation context passthrough (grant, journal, approval validator). */
  readonly invocation?: ToolInvocationContext;
}

/**
 * Run one gate through the Tool Registry and normalize its result. A tool
 * that is not registered, out of phase, over quota or failing is a failed
 * gate -- never an excuse to execute the command outside the registry.
 */
export async function runGate(
  registry: ToolRegistry,
  gate: GateDefinition,
  options: GateRunOptions,
): Promise<GateOutcome> {
  try {
    const evidence = await invokeTool(
      registry,
      {
        intent_id: options.intentId,
        tool: gate.tool,
        ...(gate.version === undefined ? {} : { version: gate.version }),
        phase: GATE_PHASE,
        ...(gate.resource === undefined ? {} : { resource: gate.resource }),
        parameters: gate.parameters,
      },
      options.invocation ?? {},
    );
    const output = isPlainObject(evidence.output) ? evidence.output : {};
    const exitCode =
      typeof output.exit_code === "number" && Number.isInteger(output.exit_code)
        ? output.exit_code
        : null;
    const passed =
      typeof output.passed === "boolean" ? output.passed : exitCode !== null && exitCode === 0;
    const summary =
      typeof output.summary === "string" && output.summary !== ""
        ? output.summary
        : exitCode === null
          ? "gate tool returned no exit code"
          : `exit code ${String(exitCode)}`;
    return outcomeOf(gate, {
      passed,
      exit_code: exitCode,
      summary,
      log_summary: typeof output.log_summary === "string" ? output.log_summary : "",
      artifact_hashes: readArtifactHashes(output.artifacts),
      ...(isPlainObject(output.extensions) ? { extensions: output.extensions } : {}),
    });
  } catch (error) {
    if (error instanceof ToolError) {
      return outcomeOf(gate, {
        passed: false,
        exit_code: null,
        summary: `gate tool invocation failed: ${error.kind}`,
        log_summary: "",
        artifact_hashes: {},
        error: error.kind,
      });
    }
    throw error;
  }
}
