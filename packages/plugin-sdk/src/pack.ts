import {
  POLICY_MERGE_OPERATORS,
  canonicalizeJson,
  contentDigest,
} from "@universal-harness-internal/core";

import { GATE_PROVIDER_LAYERS, type GateDefinitionInput } from "./gate.js";

/**
 * Canonical Pack contract (design section 5 and 13.1, plan Task 25). A pack is
 * versioned, content-addressed data: stack conventions as policy fields with
 * declared merge operators, stack-profile gate declarations, provider
 * instruction templates and the deterministic detection markers a
 * StackAdapter derives its confidence from. The descriptor is the canonical
 * artifact a project pins in its pack lock; `packDigest` over the canonical
 * form is what installation, upgrade approval and the lockfile bind.
 *
 * Packs never redefine core node semantics: policy fields only carry values
 * for paths the Policy schema declares, and gates only name tools the host
 * registers. Parsing is total -- a structurally invalid descriptor fails here
 * with a typed error before any pack content can influence a decision.
 */
export const PACK_FORMAT_VERSION = 1 as const;

export const PACK_ERROR_KINDS = ["invalid_pack_descriptor", "unsupported_pack_format"] as const;

export type PackErrorKind = (typeof PACK_ERROR_KINDS)[number];

export class PackError extends Error {
  readonly kind: PackErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: PackErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PackError";
    this.kind = kind;
    if (details !== undefined) this.details = details;
  }
}

/** Merge operators a pack policy field may declare (Policy schema, design 14.1). */
export type PackMergeOperator = (typeof POLICY_MERGE_OPERATORS)[number];

export interface PackPolicyField {
  readonly path: string;
  readonly merge_operator: PackMergeOperator;
  readonly value: unknown;
}

/** Deterministic detection markers a StackAdapter looks for at the root. */
export interface PackDetection {
  /** Root-level marker file names, e.g. `package.json`. */
  readonly markers: readonly string[];
  /** Confidence reported when at least one marker is present, in (0, 1]. */
  readonly confidence: number;
}

/** Template key every pack must provide: the neutral provider instruction. */
export const PROVIDER_INSTRUCTION_TEMPLATE = "provider_instruction" as const;

export interface PackDescriptor {
  readonly pack_format: number;
  readonly name: string;
  readonly version: string;
  readonly stack: string;
  readonly policies: readonly PackPolicyField[];
  readonly gates: readonly GateDefinitionInput[];
  readonly templates: Readonly<Record<string, string>>;
  readonly projection_views: readonly string[];
  readonly detection?: PackDetection;
}

/* Same patterns as the core pack lock; duplicated because the lockfile module
 * keeps them private and the dependency direction forbids reaching into it. */
const PACK_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/u;
const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const STACK_PATTERN = /^[a-z][a-z0-9-]*$/u;
const POLICY_PATH_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;
const TEMPLATE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/u;
const MARKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new PackError("invalid_pack_descriptor", message, details);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`pack descriptor field ${field} must be a non-empty string`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(`pack descriptor field ${field} must be an array of strings`);
  }
  return value as readonly string[];
}

/** Validate one policy field; shared by pack descriptors and project overrides. */
export function parsePackPolicyField(raw: unknown): PackPolicyField {
  if (!isPlainObject(raw)) invalid("a pack policy field must be an object");
  const path = readString(raw, "path");
  if (!POLICY_PATH_PATTERN.test(path)) {
    invalid(
      `pack policy field path ${JSON.stringify(path)} must match ${POLICY_PATH_PATTERN.source}`,
    );
  }
  const operator = raw["merge_operator"];
  if (
    typeof operator !== "string" ||
    !(POLICY_MERGE_OPERATORS as readonly string[]).includes(operator)
  ) {
    invalid(
      `pack policy field ${path} declares an unknown merge operator; ` +
        `it must be one of ${POLICY_MERGE_OPERATORS.join(", ")}`,
    );
  }
  if (!("value" in raw)) {
    invalid(`pack policy field ${path} must carry a value`);
  }
  return { path, merge_operator: operator as PackMergeOperator, value: raw["value"] };
}

function parseGate(raw: unknown): GateDefinitionInput {
  if (!isPlainObject(raw)) invalid("a pack gate must be an object");
  const gateId = readString(raw, "gate_id");
  const layer = raw["layer"];
  if (typeof layer !== "string" || !(GATE_PROVIDER_LAYERS as readonly string[]).includes(layer)) {
    invalid(`pack gate ${gateId} layer must be one of ${GATE_PROVIDER_LAYERS.join(", ")}`);
  }
  if (layer !== "stack") {
    invalid(
      `pack gate ${gateId} must be a stack-profile gate; universal and project ` +
        "gate layers are owned by the kernel and the project, never by a pack",
    );
  }
  const name = readString(raw, "name");
  const subjectId = readString(raw, "subject_id");
  const tool = readString(raw, "tool");
  if (typeof raw["mandatory"] !== "boolean") {
    invalid(`pack gate ${gateId} mandatory must be a boolean`);
  }
  if (raw["version"] !== undefined && typeof raw["version"] !== "string") {
    invalid(`pack gate ${gateId} version must be a string when present`);
  }
  if (raw["resource"] !== undefined && typeof raw["resource"] !== "string") {
    invalid(`pack gate ${gateId} resource must be a string when present`);
  }
  if (raw["parameters"] !== undefined && !isPlainObject(raw["parameters"])) {
    invalid(`pack gate ${gateId} parameters must be an object when present`);
  }
  return {
    gate_id: gateId,
    layer: "stack",
    name,
    mandatory: raw["mandatory"],
    subject_id: subjectId,
    tool,
    ...(raw["version"] === undefined ? {} : { version: raw["version"] as string }),
    ...(raw["parameters"] === undefined
      ? {}
      : { parameters: raw["parameters"] as Record<string, unknown> }),
    ...(raw["resource"] === undefined ? {} : { resource: raw["resource"] as string }),
  };
}

function parseDetection(raw: unknown): PackDetection {
  if (!isPlainObject(raw)) invalid("pack detection must be an object");
  const markers = readStringArray(raw, "markers");
  if (markers.length === 0 || markers.some((marker) => !MARKER_PATTERN.test(marker))) {
    invalid("pack detection markers must be non-empty root-level file names");
  }
  const confidence = raw["confidence"];
  if (typeof confidence !== "number" || !(confidence > 0) || confidence > 1) {
    invalid("pack detection confidence must be a number in (0, 1]");
  }
  return { markers, confidence };
}

/**
 * Validate an untrusted descriptor. Any violation is a typed error thrown
 * before the pack can be installed, locked or merged into a policy decision.
 */
export function parsePackDescriptor(raw: unknown): PackDescriptor {
  if (!isPlainObject(raw)) invalid("a pack descriptor must be an object");
  if (raw["pack_format"] !== PACK_FORMAT_VERSION) {
    throw new PackError(
      "unsupported_pack_format",
      `pack ${String(raw["name"] ?? "<unknown>")} declares pack_format ${JSON.stringify(
        raw["pack_format"],
      )}; this host supports ${String(PACK_FORMAT_VERSION)}`,
    );
  }
  const name = readString(raw, "name");
  if (!PACK_NAME_PATTERN.test(name)) {
    invalid(`pack name ${JSON.stringify(name)} must match ${PACK_NAME_PATTERN.source}`);
  }
  const version = readString(raw, "version");
  if (!SEMANTIC_VERSION_PATTERN.test(version)) {
    invalid(`pack ${name} version ${JSON.stringify(version)} must be an exact semantic version`);
  }
  const stack = readString(raw, "stack");
  if (!STACK_PATTERN.test(stack)) {
    invalid(`pack ${name} stack ${JSON.stringify(stack)} must match ${STACK_PATTERN.source}`);
  }

  const policiesRaw = raw["policies"];
  if (!Array.isArray(policiesRaw)) invalid(`pack ${name} policies must be an array`);
  const policies = policiesRaw.map(parsePackPolicyField);
  const policyPaths = new Set<string>();
  for (const field of policies) {
    if (policyPaths.has(field.path)) {
      invalid(`pack ${name} declares policy field ${field.path} twice`);
    }
    policyPaths.add(field.path);
  }

  const gatesRaw = raw["gates"];
  if (!Array.isArray(gatesRaw)) invalid(`pack ${name} gates must be an array`);
  const gates = gatesRaw.map(parseGate);
  const gateIds = new Set<string>();
  for (const gate of gates) {
    if (gateIds.has(gate.gate_id)) {
      invalid(`pack ${name} declares gate ${gate.gate_id} twice`);
    }
    gateIds.add(gate.gate_id);
  }

  const templatesRaw = raw["templates"];
  if (!isPlainObject(templatesRaw)) invalid(`pack ${name} templates must be an object`);
  const templates: Record<string, string> = {};
  for (const [key, value] of Object.entries(templatesRaw)) {
    if (!TEMPLATE_KEY_PATTERN.test(key) || typeof value !== "string" || value.trim() === "") {
      invalid(`pack ${name} template ${JSON.stringify(key)} must be a non-empty string`);
    }
    templates[key] = value;
  }
  if (templates[PROVIDER_INSTRUCTION_TEMPLATE] === undefined) {
    invalid(`pack ${name} must provide a ${PROVIDER_INSTRUCTION_TEMPLATE} template`);
  }

  const descriptor: PackDescriptor = {
    pack_format: PACK_FORMAT_VERSION,
    name,
    version,
    stack,
    policies,
    gates,
    templates,
    projection_views: readStringArray(raw, "projection_views"),
    ...(raw["detection"] === undefined ? {} : { detection: parseDetection(raw["detection"]) }),
  };
  return descriptor;
}

/** Parse a descriptor from its serialized JSON form. */
export function parsePackDescriptorJson(raw: string): PackDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("pack descriptor is not valid JSON");
  }
  return parsePackDescriptor(parsed);
}

/** Content digest over the canonical descriptor; this is what the lockfile pins. */
export function packDigest(descriptor: PackDescriptor): string {
  return contentDigest(descriptor);
}

/** Canonical serialization: one JSON document, stable key order, trailing newline. */
export function serializePackDescriptor(descriptor: PackDescriptor): string {
  return `${canonicalizeJson(descriptor)}\n`;
}
