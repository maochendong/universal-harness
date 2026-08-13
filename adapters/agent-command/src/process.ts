import { spawn } from "node:child_process";

/**
 * Provider process execution (design 13.2, 16). The provider runs as one
 * delegated child process: fixed executable plus an argument array via
 * `spawn` with `shell: false` -- no user or model text ever reaches a shell.
 * The Harness enforces the duration ceiling with a timeout kill and caps
 * captured output; both limits terminating the run are reported, never
 * silently swallowed. This is process supervision, not an OS containment
 * boundary.
 */

export interface ProcessRunOptions {
  readonly args: readonly string[];
  /** Confined working directory the provider runs in. */
  readonly cwd: string;
  /** Scrubbed environment (manifest allowlist only). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
  /** Combined stdout+stderr capture cap in bytes. */
  readonly max_output_bytes: number;
}

export interface ProcessRunResult {
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  readonly output_truncated: boolean;
  readonly duration_ms: number;
}

/** The executable could not be started at all (e.g. ENOENT). */
export class ProcessSpawnError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProcessSpawnError";
    this.code = code;
  }
}

export function runCommandProcess(
  executable: string,
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
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
            // An output flood is a runaway provider; stop it.
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
        new ProcessSpawnError(
          error.code ?? "UNKNOWN",
          `failed to start provider executable "${executable}": ${error.message}`,
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
