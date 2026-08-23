import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeRepoRelativePath } from "@universal-harness-internal/runtime";
import {
  JudgeTransportError,
  validateJudgeEndpoint,
} from "@universal-harness-internal/adapter-gate-llm-judge";

export const PROJECT_RUNTIME_CONFIG_VERSION = 3 as const;
export const SUPPORTED_PROJECT_RUNTIME_CONFIG_VERSIONS = [1, 2, 3] as const;
export const PROJECT_RUNTIME_CONFIG_PATH = ".harness/runtime.json" as const;

const DEFAULT_DSH_ENV = [
  "DEEPSEEK_API_KEY",
  "DSH_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
] as const;
const DEFAULT_GATE_ENV = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"] as const;
const IDENTIFIER = /^[a-z][A-Za-z0-9_-]{1,150}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class ProjectRuntimeConfigError extends Error {
  readonly kind = "project_runtime_config_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProjectRuntimeConfigError";
  }
}

export interface ProjectAgentConfig {
  readonly provider: "dsh";
  readonly expected_version: string;
  readonly executable: string;
  readonly launcher_args: readonly string[];
  readonly env_allowlist: readonly string[];
  readonly allowed_read_paths: readonly string[];
  readonly proposed_write_paths: readonly string[];
}

export interface ProjectGateCommandConfig {
  readonly gate_id: string;
  readonly name: string;
  readonly mandatory: boolean;
  readonly subject_id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env_allowlist: readonly string[];
  readonly timeout_ms: number;
}

export interface ProjectJudgeGateConfig {
  readonly gate_id: string;
  readonly name: string;
  readonly subject_id: string;
  readonly requested_mandatory: boolean;
  readonly endpoint: string;
  readonly model: string;
  readonly prompt_version: string;
  readonly api_key_env: string;
  readonly env_allowlist: readonly string[];
  readonly timeout_ms: number;
  readonly seed?: number;
  /** Test-only escape hatch; production endpoints remain HTTPS-only. */
  readonly allow_loopback_http?: boolean;
}

export interface ProjectJudgeGateReference {
  readonly gate_id: string;
  readonly name: string;
  readonly subject_id: string;
  readonly requested_mandatory: boolean;
  readonly provider_ref: string;
  readonly model: string;
  readonly prompt_version: string;
  readonly timeout_ms: number;
  readonly seed?: number;
}

export interface ProjectModelProviderConfig {
  readonly provider_id: string;
  readonly endpoint: string;
  readonly model: string;
  readonly api_key_env: string;
  readonly env_allowlist: readonly string[];
  readonly timeout_ms: number;
  /** Model slots / port ids this provider serves; empty means default-only. */
  readonly slots: readonly string[];
  readonly is_default: boolean;
  /** Test-only escape hatch; production endpoints remain HTTPS-only. */
  readonly allow_loopback_http?: boolean;
}

export interface ProjectModelProviderReference {
  readonly provider_ref: string;
  readonly model: string;
  readonly slots: readonly string[];
  readonly is_default: boolean;
  readonly timeout_ms: number;
}

export interface ProjectRuntimeCompatibilityDiagnostic {
  readonly deprecated: true;
  readonly code: "legacy_runtime_config_v1" | "legacy_runtime_config_v2";
}

interface ProjectRuntimeConfigBase {
  readonly agent?: ProjectAgentConfig;
  readonly gates: readonly ProjectGateCommandConfig[];
  /** Non-enumerable read diagnostic; never persisted back into the project. */
  readonly compatibility?: ProjectRuntimeCompatibilityDiagnostic;
}

export interface ProjectRuntimeConfigV1 extends ProjectRuntimeConfigBase {
  readonly runtime_config_version: 1;
  readonly judge_gates?: undefined;
  readonly model_providers?: undefined;
}

export interface ProjectRuntimeConfigV2 extends ProjectRuntimeConfigBase {
  readonly runtime_config_version: 2;
  readonly judge_gates: readonly ProjectJudgeGateConfig[];
  readonly model_providers?: readonly ProjectModelProviderConfig[];
}

export interface ProjectRuntimeConfigV3 extends ProjectRuntimeConfigBase {
  readonly runtime_config_version: 3;
  readonly judge_gates: readonly ProjectJudgeGateReference[];
  readonly model_providers?: readonly ProjectModelProviderReference[];
}

export type ProjectRuntimeConfig =
  ProjectRuntimeConfigV1 | ProjectRuntimeConfigV2 | ProjectRuntimeConfigV3;

function fail(message: string): never {
  throw new ProjectRuntimeConfigError(message);
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${context} contains unknown field ${key}`);
  }
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\0\r\n]/u.test(value)) {
    fail(`${context} must be a non-empty single-line string`);
  }
  return value;
}

function stringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value.map((entry, index) => string(entry, `${context}[${String(index)}]`));
}

function envList(value: unknown, defaults: readonly string[], context: string): string[] {
  const values = value === undefined ? [...defaults] : stringList(value, context);
  if (values.some((name) => !ENV_NAME.test(name))) fail(`${context} contains an invalid name`);
  return [...new Set(values)].sort();
}

function paths(value: unknown, context: string, writable: boolean): string[] {
  const normalized = stringList(value, context).map(normalizeRepoRelativePath);
  if (
    writable &&
    normalized.some(
      (path) =>
        path === ".git" ||
        path.startsWith(".git/") ||
        path === ".harness" ||
        path.startsWith(".harness/"),
    )
  ) {
    fail(`${context} cannot grant writes to .git or .harness`);
  }
  return [...new Set(normalized)].sort();
}

function parseAgent(value: unknown): ProjectAgentConfig {
  const record = object(value, "agent");
  if (record.provider !== "dsh") fail('agent.provider must be "dsh"');
  return {
    provider: "dsh",
    expected_version: string(record.expected_version, "agent.expected_version"),
    executable:
      record.executable === undefined ? "npx" : string(record.executable, "agent.executable"),
    launcher_args:
      record.launcher_args === undefined
        ? ["--no-install", "@deepseek-ai/dsh"]
        : stringList(record.launcher_args, "agent.launcher_args"),
    env_allowlist: envList(record.env_allowlist, DEFAULT_DSH_ENV, "agent.env_allowlist"),
    allowed_read_paths: paths(record.allowed_read_paths, "agent.allowed_read_paths", false),
    proposed_write_paths: paths(record.proposed_write_paths, "agent.proposed_write_paths", true),
  };
}

function parseGate(value: unknown, index: number): ProjectGateCommandConfig {
  const context = `gates[${String(index)}]`;
  const record = object(value, context);
  const gateId = string(record.gate_id, `${context}.gate_id`);
  const subjectId = string(record.subject_id, `${context}.subject_id`);
  if (!gateId.startsWith("gate_") || !IDENTIFIER.test(gateId)) {
    fail(`${context}.gate_id must be a gate_ identifier`);
  }
  if (!IDENTIFIER.test(subjectId)) fail(`${context}.subject_id must be an identifier`);
  if (typeof record.mandatory !== "boolean") fail(`${context}.mandatory must be a boolean`);
  const timeout = record.timeout_ms;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 3600000) {
    fail(`${context}.timeout_ms must be an integer between 1 and 3600000`);
  }
  return {
    gate_id: gateId,
    name: string(record.name, `${context}.name`),
    mandatory: record.mandatory,
    subject_id: subjectId,
    executable: normalizeRepoRelativePath(string(record.executable, `${context}.executable`)),
    args: stringList(record.args ?? [], `${context}.args`),
    env_allowlist: envList(record.env_allowlist, DEFAULT_GATE_ENV, `${context}.env_allowlist`),
    timeout_ms: timeout as number,
  };
}

function parseJudgeGate(value: unknown, index: number): ProjectJudgeGateConfig {
  const context = `judge_gates[${String(index)}]`;
  const record = object(value, context);
  exactKeys(
    record,
    [
      "gate_id",
      "name",
      "subject_id",
      "requested_mandatory",
      "endpoint",
      "model",
      "prompt_version",
      "api_key_env",
      "env_allowlist",
      "timeout_ms",
      "seed",
      "allow_loopback_http",
    ],
    context,
  );
  const gateId = string(record.gate_id, `${context}.gate_id`);
  const subjectId = string(record.subject_id, `${context}.subject_id`);
  if (!gateId.startsWith("gate_") || !IDENTIFIER.test(gateId)) {
    fail(`${context}.gate_id must be a gate_ identifier`);
  }
  if (!IDENTIFIER.test(subjectId)) fail(`${context}.subject_id must be an identifier`);
  if (typeof record.requested_mandatory !== "boolean") {
    fail(`${context}.requested_mandatory must be a boolean`);
  }
  const timeout = record.timeout_ms;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 300000) {
    fail(`${context}.timeout_ms must be an integer between 1 and 300000`);
  }
  const apiKeyEnv = string(record.api_key_env, `${context}.api_key_env`);
  if (!ENV_NAME.test(apiKeyEnv)) fail(`${context}.api_key_env is invalid`);
  const allowLoopbackHttp = record.allow_loopback_http;
  if (allowLoopbackHttp !== undefined && typeof allowLoopbackHttp !== "boolean") {
    fail(`${context}.allow_loopback_http must be a boolean`);
  }
  const endpoint = string(record.endpoint, `${context}.endpoint`);
  try {
    validateJudgeEndpoint(endpoint, {
      ...(allowLoopbackHttp === undefined ? {} : { allowLoopbackHttp }),
    });
  } catch (error) {
    const detail = error instanceof JudgeTransportError ? error.message : String(error);
    fail(`${context}.endpoint is invalid: ${detail}`);
  }
  const allowlist = envList(record.env_allowlist, [], `${context}.env_allowlist`);
  if (!allowlist.includes(apiKeyEnv)) fail(`${context}.env_allowlist must contain api_key_env`);
  const seed = record.seed;
  if (seed !== undefined && (!Number.isSafeInteger(seed) || (seed as number) < 0)) {
    fail(`${context}.seed must be a non-negative safe integer`);
  }
  return {
    gate_id: gateId,
    name: string(record.name, `${context}.name`),
    subject_id: subjectId,
    requested_mandatory: record.requested_mandatory,
    endpoint,
    model: string(record.model, `${context}.model`),
    prompt_version: string(record.prompt_version, `${context}.prompt_version`),
    api_key_env: apiKeyEnv,
    env_allowlist: allowlist,
    timeout_ms: timeout as number,
    ...(seed === undefined ? {} : { seed: seed as number }),
    ...(allowLoopbackHttp === undefined ? {} : { allow_loopback_http: allowLoopbackHttp }),
  };
}

function parseModelProvider(value: unknown, index: number): ProjectModelProviderConfig {
  const context = `model_providers[${String(index)}]`;
  const record = object(value, context);
  exactKeys(
    record,
    [
      "provider_id",
      "endpoint",
      "model",
      "api_key_env",
      "env_allowlist",
      "timeout_ms",
      "slots",
      "default",
      "allow_loopback_http",
    ],
    context,
  );
  const providerId = string(record.provider_id, `${context}.provider_id`);
  if (!IDENTIFIER.test(providerId)) fail(`${context}.provider_id must be an identifier`);
  const timeout = record.timeout_ms;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 300000) {
    fail(`${context}.timeout_ms must be an integer between 1 and 300000`);
  }
  const apiKeyEnv = string(record.api_key_env, `${context}.api_key_env`);
  if (!ENV_NAME.test(apiKeyEnv)) fail(`${context}.api_key_env is invalid`);
  const allowLoopbackHttp = record.allow_loopback_http;
  if (allowLoopbackHttp !== undefined && typeof allowLoopbackHttp !== "boolean") {
    fail(`${context}.allow_loopback_http must be a boolean`);
  }
  const endpoint = string(record.endpoint, `${context}.endpoint`);
  try {
    validateJudgeEndpoint(endpoint, {
      ...(allowLoopbackHttp === undefined ? {} : { allowLoopbackHttp }),
    });
  } catch (error) {
    const detail = error instanceof JudgeTransportError ? error.message : String(error);
    fail(`${context}.endpoint is invalid: ${detail}`);
  }
  const allowlist = envList(record.env_allowlist, [], `${context}.env_allowlist`);
  if (!allowlist.includes(apiKeyEnv)) fail(`${context}.env_allowlist must contain api_key_env`);
  const slots = stringList(record.slots ?? [], `${context}.slots`);
  for (const [slotIndex, slot] of slots.entries()) {
    if (!IDENTIFIER.test(slot))
      fail(`${context}.slots[${String(slotIndex)}] must be an identifier`);
  }
  const isDefault = record.default ?? false;
  if (typeof isDefault !== "boolean") fail(`${context}.default must be a boolean`);
  return {
    provider_id: providerId,
    endpoint,
    model: string(record.model, `${context}.model`),
    api_key_env: apiKeyEnv,
    env_allowlist: allowlist,
    timeout_ms: timeout as number,
    slots: [...new Set(slots)].sort(),
    is_default: isDefault,
    ...(allowLoopbackHttp === undefined ? {} : { allow_loopback_http: allowLoopbackHttp }),
  };
}

function parseJudgeGateReference(value: unknown, index: number): ProjectJudgeGateReference {
  const context = `judge_gates[${String(index)}]`;
  const record = object(value, context);
  exactKeys(
    record,
    [
      "gate_id",
      "name",
      "subject_id",
      "requested_mandatory",
      "provider_ref",
      "model",
      "prompt_version",
      "timeout_ms",
      "seed",
    ],
    context,
  );
  const gateId = string(record.gate_id, `${context}.gate_id`);
  const subjectId = string(record.subject_id, `${context}.subject_id`);
  const providerRef = string(record.provider_ref, `${context}.provider_ref`);
  if (!gateId.startsWith("gate_") || !IDENTIFIER.test(gateId)) {
    fail(`${context}.gate_id must be a gate_ identifier`);
  }
  if (!IDENTIFIER.test(subjectId)) fail(`${context}.subject_id must be an identifier`);
  if (!IDENTIFIER.test(providerRef)) fail(`${context}.provider_ref must be an identifier`);
  if (typeof record.requested_mandatory !== "boolean") {
    fail(`${context}.requested_mandatory must be a boolean`);
  }
  const timeout = record.timeout_ms;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 300000) {
    fail(`${context}.timeout_ms must be an integer between 1 and 300000`);
  }
  const seed = record.seed;
  if (seed !== undefined && (!Number.isSafeInteger(seed) || (seed as number) < 0)) {
    fail(`${context}.seed must be a non-negative safe integer`);
  }
  return {
    gate_id: gateId,
    name: string(record.name, `${context}.name`),
    subject_id: subjectId,
    requested_mandatory: record.requested_mandatory,
    provider_ref: providerRef,
    model: string(record.model, `${context}.model`),
    prompt_version: string(record.prompt_version, `${context}.prompt_version`),
    timeout_ms: timeout as number,
    ...(seed === undefined ? {} : { seed: seed as number }),
  };
}

function parseModelProviderReference(value: unknown, index: number): ProjectModelProviderReference {
  const context = `model_providers[${String(index)}]`;
  const record = object(value, context);
  exactKeys(record, ["provider_ref", "model", "timeout_ms", "slots", "is_default"], context);
  const providerRef = string(record.provider_ref, `${context}.provider_ref`);
  if (!IDENTIFIER.test(providerRef)) fail(`${context}.provider_ref must be an identifier`);
  const timeout = record.timeout_ms;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 300000) {
    fail(`${context}.timeout_ms must be an integer between 1 and 300000`);
  }
  const slots = stringList(record.slots ?? [], `${context}.slots`);
  for (const [slotIndex, slot] of slots.entries()) {
    if (!IDENTIFIER.test(slot)) {
      fail(`${context}.slots[${String(slotIndex)}] must be an identifier`);
    }
  }
  if (typeof record.is_default !== "boolean") fail(`${context}.is_default must be a boolean`);
  return {
    provider_ref: providerRef,
    model: string(record.model, `${context}.model`),
    slots: [...new Set(slots)].sort(),
    is_default: record.is_default,
    timeout_ms: timeout as number,
  };
}

function withCompatibility<T extends ProjectRuntimeConfigV1 | ProjectRuntimeConfigV2>(
  config: T,
): T {
  Object.defineProperty(config, "compatibility", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: {
      deprecated: true,
      code: `legacy_runtime_config_v${String(config.runtime_config_version)}`,
    },
  });
  return config;
}

/** Read and strictly normalize the optional committed project runtime configuration. */
export function readProjectRuntimeConfig(projectRoot: string): ProjectRuntimeConfig {
  const absolute = join(projectRoot, PROJECT_RUNTIME_CONFIG_PATH);
  if (!existsSync(absolute)) return withCompatibility({ runtime_config_version: 1, gates: [] });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    fail(`${PROJECT_RUNTIME_CONFIG_PATH} is not valid JSON`);
  }
  const record = object(raw, "project runtime config");
  exactKeys(
    record,
    ["runtime_config_version", "agent", "gates", "judge_gates", "model_providers"],
    "project runtime config",
  );
  if (
    !SUPPORTED_PROJECT_RUNTIME_CONFIG_VERSIONS.includes(record.runtime_config_version as 1 | 2 | 3)
  ) {
    fail(`unsupported runtime_config_version: ${JSON.stringify(record.runtime_config_version)}`);
  }
  const version = record.runtime_config_version as 1 | 2 | 3;
  const gatesRaw = record.gates ?? [];
  if (!Array.isArray(gatesRaw)) fail("gates must be an array");
  const gates = gatesRaw.map(parseGate);
  const ids = new Set<string>();
  for (const gate of gates) {
    if (ids.has(gate.gate_id)) fail(`gate ${gate.gate_id} is declared twice`);
    ids.add(gate.gate_id);
  }
  if (version === 1 && record.judge_gates !== undefined) {
    fail("judge_gates requires runtime_config_version 2");
  }
  const judgesRaw = version >= 2 ? (record.judge_gates ?? []) : [];
  if (!Array.isArray(judgesRaw)) fail("judge_gates must be an array");
  const judgeGates =
    version === 3 ? judgesRaw.map(parseJudgeGateReference) : judgesRaw.map(parseJudgeGate);
  for (const gate of judgeGates) {
    if (ids.has(gate.gate_id)) fail(`gate ${gate.gate_id} is declared twice`);
    ids.add(gate.gate_id);
  }
  if (version === 1 && record.model_providers !== undefined) {
    fail("model_providers requires runtime_config_version 2");
  }
  const providersRaw = version >= 2 ? record.model_providers : undefined;
  let modelProviders: ProjectModelProviderConfig[] | ProjectModelProviderReference[] | undefined;
  if (providersRaw !== undefined) {
    if (!Array.isArray(providersRaw)) fail("model_providers must be an array");
    modelProviders =
      version === 3
        ? providersRaw.map(parseModelProviderReference)
        : providersRaw.map(parseModelProvider);
    const providerIds = new Set<string>();
    let defaults = 0;
    for (const provider of modelProviders) {
      const providerRef = "provider_ref" in provider ? provider.provider_ref : provider.provider_id;
      if (providerIds.has(providerRef)) {
        fail(`model provider ${providerRef} is declared twice`);
      }
      providerIds.add(providerRef);
      if (provider.is_default) defaults += 1;
    }
    if (defaults > 1) fail("model_providers allows at most one default provider");
  }
  const agent = record.agent === undefined ? {} : { agent: parseAgent(record.agent) };
  if (version === 1) {
    return withCompatibility({ runtime_config_version: 1, ...agent, gates });
  }
  if (version === 2) {
    return withCompatibility({
      runtime_config_version: 2,
      ...agent,
      gates,
      judge_gates: judgeGates as ProjectJudgeGateConfig[],
      ...(modelProviders === undefined
        ? {}
        : { model_providers: modelProviders as ProjectModelProviderConfig[] }),
    });
  }
  return {
    runtime_config_version: 3,
    ...agent,
    gates,
    judge_gates: judgeGates as ProjectJudgeGateReference[],
    model_providers: (modelProviders ?? []) as ProjectModelProviderReference[],
  };
}
