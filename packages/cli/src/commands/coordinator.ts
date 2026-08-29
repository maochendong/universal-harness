import { realpathSync } from "node:fs";
import { isAbsolute, basename, dirname, resolve } from "node:path";

import { findProjectRoot } from "@universal-harness-internal/core";

import { usageError } from "../errors.js";
import { parseCommandArgs, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE =
  "harness coordinator --host <host> --port <port> --tls-cert <path> --tls-key <path> --config <path>";

/** Bind hosts stay syntactic: letters, digits, dot, colon (IPv6) and dash. */
const HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/u;

/** TLS material is host-owned: absolute paths outside every managed project. */
function assertHostOwnedPath(flag: string, value: string | boolean | undefined): string {
  if (typeof value !== "string" || value === "") {
    throw usageError(`harness coordinator requires ${flag} <path>; usage: ${USAGE}`);
  }
  if (!isAbsolute(value)) {
    throw usageError(`${flag} must be an absolute path; usage: ${USAGE}`);
  }
  // Resolve symlinks before the project check: a symlink inside a managed
  // project must not smuggle host material in, and a symlink into a managed
  // project must not smuggle it out.
  let resolved: string;
  try {
    resolved = realpathSync(value);
  } catch {
    try {
      resolved = resolve(realpathSync(dirname(value)), basename(value));
    } catch {
      resolved = resolve(value);
    }
  }
  if (findProjectRoot(dirname(resolved)) !== undefined) {
    throw usageError(`${flag} must live outside every managed project; usage: ${USAGE}`);
  }
  return value;
}

/**
 * Thin route for the host-only Coordinator (plan M3 Task 7 step 3). The
 * command runs outside any managed project; the runtime composes the
 * Coordinator, Git adapter and SQLite projection and refuses startup without
 * TLS.
 */
export async function runCoordinatorCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      host: { type: "string" },
      port: { type: "string" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
      config: { type: "string" },
    },
    USAGE,
  );
  if (positionals.length > 0) {
    throw usageError(`harness coordinator takes no positional arguments; usage: ${USAGE}`);
  }
  const rawPort = values["port"];
  if (typeof rawPort !== "string" || !/^[0-9]+$/u.test(rawPort)) {
    throw usageError(`harness coordinator requires --port <1..65535>; usage: ${USAGE}`);
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw usageError(`--port must be an integer in 1..65535; usage: ${USAGE}`);
  }
  const config = values["config"];
  if (typeof config !== "string" || config === "") {
    throw usageError(`harness coordinator requires --config <path>; usage: ${USAGE}`);
  }
  const tlsCert = assertHostOwnedPath("--tls-cert", values["tls-cert"]);
  const tlsKey = assertHostOwnedPath("--tls-key", values["tls-key"]);
  const host = values["host"];
  if (host !== undefined && (typeof host !== "string" || !HOST_PATTERN.test(host))) {
    throw usageError(`--host must be a non-empty hostname or address; usage: ${USAGE}`);
  }
  return context.runtime.coordinator({
    ...(typeof host === "string" ? { host } : {}),
    port,
    tlsCert,
    tlsKey,
    configPath: isAbsolute(config) ? config : resolve(context.cwd, config),
  });
}
