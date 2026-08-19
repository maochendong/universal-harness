import { canonicalizeJson, findProjectRoot } from "@universal-harness-internal/core";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import { projectNotFound, usageError, type CliError, type ExitCode, EXIT_CODES } from "./errors.js";

/**
 * CLI input/output plumbing. Every command handler returns one canonical
 * `CommandResult` record; human-readable text and `--json` output are both
 * rendered from that single record, so the two representations can never
 * drift apart (design section 11.3). `--json` uses the core canonical JSON
 * serializer, which keeps output deterministic across platforms and runs.
 */
export interface CliIo {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  /**
   * False when stdout is not a terminal (piped, CI, tests). Non-interactive
   * mode never reads stdin and never auto-approves; handlers receive this
   * flag through the command context.
   */
  readonly isInteractive: boolean;
}

export function createProcessIo(): CliIo {
  return {
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    isInteractive: Boolean(process.stdout.isTTY),
  };
}

export type CommandStatus =
  "ok" | "failed" | "input_required" | "stage_unavailable" | "approval_required" | "blocked";

export interface CommandResult {
  readonly command: string;
  readonly status: CommandStatus;
  /** One-line human summary derived from `data`. */
  readonly message: string;
  readonly data: Record<string, unknown>;
}

export function exitCodeForStatus(status: CommandStatus): ExitCode {
  switch (status) {
    case "ok":
      return EXIT_CODES.ok;
    case "failed":
      return EXIT_CODES.operationFailed;
    case "input_required":
      return EXIT_CODES.inputRequired;
    case "stage_unavailable":
      return EXIT_CODES.stageUnavailable;
    case "approval_required":
      return EXIT_CODES.approvalRequired;
    case "blocked":
      return EXIT_CODES.blocked;
  }
}

export function renderJson(result: CommandResult): string {
  return `${canonicalizeJson(result)}\n`;
}

export function renderHuman(result: CommandResult): string {
  const lines = [`${result.command}: ${result.message}`];
  const entries = Object.entries(result.data).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [key, value] of entries) {
    const rendered =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : canonicalizeJson(value);
    lines.push(`  ${key}: ${rendered}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface ErrorEnvelope {
  readonly status: "error";
  readonly category: CliError["category"];
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export function renderError(error: CliError, json: boolean): string {
  if (json) {
    const envelope: ErrorEnvelope = {
      status: "error",
      category: error.category,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
    return `${canonicalizeJson(envelope)}\n`;
  }
  return `error [${error.category}]: ${error.message}\n`;
}

/**
 * Resolve the managed project root containing `cwd`, or fail with the stable
 * `project_not_found` category. Shared plumbing for commands that operate on
 * an existing project; orchestration handlers never fake success without it.
 */
export function requireProjectRoot(cwd: string): string {
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot === undefined) {
    throw projectNotFound(`no managed project found at or above ${cwd}`);
  }
  return projectRoot;
}

export interface ParsedCommandArgs {
  readonly values: Record<string, string | boolean | undefined>;
  readonly positionals: string[];
}

/**
 * Strict per-command argument parsing built on `node:util` parseArgs (no
 * third-party dependency). Unknown options and malformed values become typed
 * usage errors with a stable exit code instead of crashing the process.
 */
export function parseCommandArgs(
  args: readonly string[],
  options: ParseArgsOptionsConfig,
  usage: string,
): ParsedCommandArgs {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return {
      values: parsed.values as Record<string, string | boolean | undefined>,
      positionals: parsed.positionals,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw usageError(`${detail}; usage: ${usage}`);
  }
}
