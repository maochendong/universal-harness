import { execFile } from "node:child_process";

import {
  vcsErr,
  vcsOk,
  type VcsError,
  type VcsErrorKind,
  type VcsResult,
} from "@universal-harness-internal/plugin-sdk";

export interface GitRunnerOptions {
  /** Git executable; fixed and never interpolated into a shell. */
  readonly executable?: string;
  /** Per-command timeout in milliseconds. */
  readonly timeoutMs?: number;
}

export type GitOutcome = VcsResult<{ stdout: string; stderr: string }>;

export type GitRunner = (
  operation: string,
  cwd: string,
  args: readonly string[],
) => Promise<GitOutcome>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** Spawn failures, timeouts and non-zero exits become typed VCS errors. */
function normalizeSpawnError(operation: string, error: unknown, capturedStderr: string): VcsError {
  const record = (error ?? {}) as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    message?: unknown;
  };
  const stderr = capturedStderr.length > 0 ? capturedStderr : undefined;
  const message = typeof record.message === "string" ? record.message : "git command failed";

  if (record.code === "ENOENT") {
    return {
      kind: "executable_unavailable",
      operation,
      message: "git executable could not be spawned",
      ...(stderr !== undefined ? { stderr } : {}),
    };
  }
  if (record.killed === true || typeof record.signal === "string") {
    return {
      kind: "command_failed",
      operation,
      message: "git command was killed or timed out",
      ...(stderr !== undefined ? { stderr } : {}),
    };
  }
  return {
    kind: "command_failed",
    operation,
    message,
    ...(stderr !== undefined ? { stderr } : {}),
    ...(typeof record.code === "number" ? { exitCode: record.code } : {}),
  };
}

/**
 * Run git with a fixed executable and an argument array. No user text is ever
 * interpolated into a shell: arguments reach git verbatim via `execFile`.
 */
export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const executable = options.executable ?? "git";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (operation, cwd, args) =>
    new Promise<GitOutcome>((resolve) => {
      execFile(
        executable,
        [...args],
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            // Never prompt and keep output parseable regardless of locale.
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
          },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(vcsOk({ stdout, stderr }));
            return;
          }
          const normalized = normalizeSpawnError(operation, error, stderr);
          resolve(
            vcsErr(
              typeof stderr === "string" && stderr.includes("not a git repository")
                ? {
                    kind: "not_a_repository",
                    operation,
                    message: "path is not inside a git repository",
                    stderr,
                    ...(normalized.exitCode !== undefined ? { exitCode: normalized.exitCode } : {}),
                  }
                : normalized,
            ),
          );
        },
      );
    });
}

/**
 * Narrow a generic `command_failed` outcome to an operation-specific kind.
 * Other kinds pass through untouched; `match` (when given) must hit the
 * captured stderr or message for the narrowing to apply.
 */
export function narrowError<T>(
  result: VcsResult<T>,
  kind: VcsErrorKind,
  match?: RegExp,
): VcsResult<T> {
  if (result.ok || result.error.kind !== "command_failed") return result;
  if (match !== undefined) {
    const haystack = `${result.error.message}\n${result.error.stderr ?? ""}`;
    if (!match.test(haystack)) return result;
  }
  return vcsErr({ ...result.error, kind });
}
