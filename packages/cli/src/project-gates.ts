import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ProcessSpawnError,
  runCommandProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "@universal-harness-internal/adapter-agent-command";
import { sha256Hex } from "@universal-harness-internal/core";
import {
  assertWithinRepositoryBoundary,
  createDefaultGateSuite,
  normalizeGateDefinition,
  type GateDefinition,
  type ToolRegistry,
} from "@universal-harness-internal/runtime";

import type { ProjectRuntimeConfig } from "./project-runtime-config.js";

export type GateProcessRunner = (
  executable: string,
  options: ProcessRunOptions,
) => Promise<ProcessRunResult>;

export interface ConfiguredGateSuiteOptions {
  readonly spawnProcess?: GateProcessRunner;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
}

function environmentFor(
  allowlist: readonly string[],
  ambient: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of allowlist) {
    const value = ambient[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function gateToolName(gateId: string): string {
  return `project_${gateId}`;
}

/** Assemble universal integrity and committed project command gates into one suite. */
export function createConfiguredGateSuite(
  projectRoot: string,
  config: ProjectRuntimeConfig,
  options: ConfiguredGateSuiteOptions = {},
): { readonly gates: readonly GateDefinition[]; readonly registry: ToolRegistry } {
  const suite = createDefaultGateSuite(projectRoot);
  const gates: GateDefinition[] = [...suite.gates];
  const spawnProcess = options.spawnProcess ?? runCommandProcess;
  const ambient = options.ambientEnvironment ?? process.env;

  for (const command of config.gates) {
    const executable = assertWithinRepositoryBoundary(projectRoot, command.executable);
    const tool = gateToolName(command.gate_id);
    suite.registry.register(
      {
        name: tool,
        version: "1.0.0",
        description: `run committed project gate ${command.gate_id}`,
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        output_schema: {
          type: "object",
          properties: {
            exit_code: { type: "integer" },
            passed: { type: "boolean" },
            summary: { type: "string" },
            log_summary: { type: "string" },
            artifacts: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["exit_code", "passed", "summary", "log_summary", "artifacts"],
          additionalProperties: false,
        },
        allowed_phases: ["verification"],
        resource_patterns: [],
        risk: "low",
        side_effect_class: "none",
        requires_approval: false,
        timeout_ms: command.timeout_ms,
        retry_class: "none",
        max_retries: 0,
        max_invocations_per_run: 10,
        idempotent: true,
        reconciliation: "provider",
      },
      async () => {
        let result: ProcessRunResult;
        try {
          result = await spawnProcess(executable, {
            args: command.args,
            cwd: projectRoot,
            env: environmentFor(command.env_allowlist, ambient),
            timeout_ms: command.timeout_ms,
            max_output_bytes: 4 * 1024 * 1024,
          });
        } catch (error) {
          if (!(error instanceof ProcessSpawnError)) throw error;
          result = {
            exit_code: 127,
            signal: null,
            stdout: "",
            stderr: error.message,
            timed_out: false,
            output_truncated: false,
            duration_ms: 0,
          };
        }
        const effectiveExitCode = result.timed_out
          ? 124
          : result.output_truncated
            ? 125
            : (result.exit_code ?? 126);
        const passed = effectiveExitCode === 0;
        const log = [
          `gate=${command.gate_id}`,
          `exit_code=${String(effectiveExitCode)}`,
          `duration_ms=${String(result.duration_ms)}`,
          "stdout:",
          result.stdout,
          "stderr:",
          result.stderr,
        ].join("\n");
        const relativeLog = `.harness/raw-traces/gates/${command.gate_id}.log`;
        const absoluteLog = join(projectRoot, relativeLog);
        mkdirSync(dirname(absoluteLog), { recursive: true });
        writeFileSync(absoluteLog, log, "utf8");
        const combined = `${result.stdout}\n${result.stderr}`.trim();
        return {
          exit_code: effectiveExitCode,
          passed,
          summary: `${command.name} ${passed ? "passed" : "failed"}`,
          log_summary: combined.slice(-2000),
          artifacts: { [relativeLog]: sha256Hex(log) },
        };
      },
    );
    gates.push(
      normalizeGateDefinition({
        gate_id: command.gate_id,
        layer: "project",
        name: command.name,
        mandatory: command.mandatory,
        subject_id: command.subject_id,
        tool,
      }),
    );
  }
  return { gates, registry: suite.registry };
}
