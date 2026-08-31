import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

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
  /** Disposable, best-effort observation of output accepted under the cap. */
  readonly on_output?: (output: PluginSubprocessOutput) => void;
  /**
   * Optional cooperative termination request (M4). Aborting sends exactly one
   * SIGTERM to the supervised child; the resulting `aborted` flag is the only
   * confirmation the termination landed -- the abort intent alone proves
   * nothing.
   */
  readonly signal?: AbortSignal;
}

export interface PluginSubprocessOutput {
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

export interface PluginSubprocessResult {
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  readonly output_truncated: boolean;
  /**
   * `true` only when the caller's AbortSignal fired and this runner sent the
   * SIGTERM that ended the process. Distinct from `timed_out` and
   * `output_truncated` so a cancellation is never misread as a limit kill.
   */
  readonly aborted: boolean;
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
    let aborted = false;
    let settled = false;
    // Timeout, output-cap and abort all terminate via the same single SIGTERM;
    // the flags record which limit (or the caller) actually fired it.
    let sigtermSent = false;
    const terminate = (): void => {
      if (sigtermSent || settled) return;
      sigtermSent = true;
      child.kill("SIGTERM");
    };
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    const detachAbortListener = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const observe = (stream: PluginSubprocessOutput["stream"], chunk: string): void => {
      if (chunk === "" || options.on_output === undefined) return;
      try {
        options.on_output({ stream, chunk });
      } catch {
        // Output observation is explicitly disposable and cannot affect the
        // governed process result.
      }
    };

    const collect =
      (stream: PluginSubprocessOutput["stream"], chunks: Buffer[]) =>
      (chunk: Buffer): void => {
        if (captured + chunk.length > options.max_output_bytes) {
          if (!truncated) {
            truncated = true;
            // An output flood is a runaway plugin; stop it.
            terminate();
          }
          return;
        }
        captured += chunk.length;
        chunks.push(chunk);
        observe(stream, decoders[stream].write(chunk));
      };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeout_ms);

    child.stdout.on("data", collect("stdout", stdoutChunks));
    child.stderr.on("data", collect("stderr", stderrChunks));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachAbortListener();
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
      detachAbortListener();
      observe("stdout", decoders.stdout.end());
      observe("stderr", decoders.stderr.end());
      resolve({
        exit_code: exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timed_out: timedOut,
        output_truncated: truncated,
        aborted,
        duration_ms: Math.max(0, Date.now() - started),
      });
    });
  });
}
