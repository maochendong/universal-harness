import { spawn } from "node:child_process";

/**
 * Minimized plugin subprocess execution (design 14, plan Task 24 step 3). A
 * plugin that must run out of process executes as one child process with a
 * fixed executable and argument array via `spawn` with `shell: false` -- no
 * user or model text ever reaches a shell. The environment is scrubbed to an
 * explicit allowlist, the working directory is confined by the caller, the
 * host enforces a duration ceiling with a timeout kill, and captured output
 * is capped; both limits terminating the run are reported on the result,
 * never silently swallowed. This is process supervision, not an OS
 * containment boundary.
 */

export const SUBPROCESS_ERROR_KINDS = ["spawn_failed"] as const;

export type PluginSubprocessErrorKind = (typeof SUBPROCESS_ERROR_KINDS)[number];

/** The executable could not be started at all (e.g. ENOENT). */
export class PluginSubprocessError extends Error {
  readonly kind: PluginSubprocessErrorKind;
  /** OS-level error code, e.g. `ENOENT`. */
  readonly code: string;

  constructor(kind: PluginSubprocessErrorKind, code: string, message: string) {
    super(message);
    this.name = "PluginSubprocessError";
    this.kind = kind;
    this.code = code;
  }
}

export interface PluginSubprocessOptions {
  readonly args: readonly string[];
  /** Confined working directory the plugin runs in. */
  readonly cwd: string;
  /** Scrubbed environment; exactly these variables are passed through. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
  /** Combined stdout+stderr capture cap in bytes. */
  readonly max_output_bytes: number;
}

export interface PluginSubprocessResult {
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  readonly output_truncated: boolean;
  readonly duration_ms: number;
}

/**
 * Build the scrubbed environment for a plugin process: only allowlisted
 * variables pass through from the ambient environment, in sorted order.
 */
export function buildScrubbedEnvironment(
  allowlist: readonly string[],
  ambient: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...allowlist].sort()) {
    const value = ambient[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Run one plugin subprocess under the declared limits. Spawn failure rejects
 * with a typed `PluginSubprocessError`; timeout and output-cap kills resolve
 * with the corresponding flags set so the caller can record them as evidence.
 */
export function runPluginSubprocess(
  executable: string,
  options: PluginSubprocessOptions,
): Promise<PluginSubprocessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(executable, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect =
      (chunks: Buffer[]) =>
      (chunk: Buffer): void => {
        if (captured + chunk.length > options.max_output_bytes) {
          if (!truncated) {
            truncated = true;
            // An output flood is a runaway plugin; stop it.
            child.kill("SIGTERM");
          }
          return;
        }
        captured += chunk.length;
        chunks.push(chunk);
      };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeout_ms);

    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new PluginSubprocessError(
          "spawn_failed",
          error.code ?? "UNKNOWN",
          `failed to start plugin executable "${executable}": ${error.message}`,
        ),
      );
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timed_out: timedOut,
        output_truncated: truncated,
        duration_ms: Math.max(0, Date.now() - started),
      });
    });
  });
}
