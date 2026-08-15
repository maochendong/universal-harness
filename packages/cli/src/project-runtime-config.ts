import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeRepoRelativePath } from "@universal-harness-internal/runtime";

export const PROJECT_RUNTIME_CONFIG_VERSION = 1 as const;
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

export interface ProjectRuntimeConfig {
  readonly runtime_config_version: 1;
  readonly agent?: ProjectAgentConfig;
  readonly gates: readonly ProjectGateCommandConfig[];
}

function fail(message: string): never {
  throw new ProjectRuntimeConfigError(message);
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
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

/** Read and strictly normalize the optional committed project runtime configuration. */
export function readProjectRuntimeConfig(projectRoot: string): ProjectRuntimeConfig {
  const absolute = join(projectRoot, PROJECT_RUNTIME_CONFIG_PATH);
  if (!existsSync(absolute)) return { runtime_config_version: 1, gates: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    fail(`${PROJECT_RUNTIME_CONFIG_PATH} is not valid JSON`);
  }
  const record = object(raw, "project runtime config");
  if (record.runtime_config_version !== PROJECT_RUNTIME_CONFIG_VERSION) {
    fail(`unsupported runtime_config_version: ${JSON.stringify(record.runtime_config_version)}`);
  }
  const gatesRaw = record.gates ?? [];
  if (!Array.isArray(gatesRaw)) fail("gates must be an array");
  const gates = gatesRaw.map(parseGate);
  const ids = new Set<string>();
  for (const gate of gates) {
    if (ids.has(gate.gate_id)) fail(`gate ${gate.gate_id} is declared twice`);
    ids.add(gate.gate_id);
  }
  return {
    runtime_config_version: PROJECT_RUNTIME_CONFIG_VERSION,
    ...(record.agent === undefined ? {} : { agent: parseAgent(record.agent) }),
    gates,
  };
}
