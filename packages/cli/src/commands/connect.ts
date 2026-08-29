import { normalizeCoordinatorOrigin } from "@universal-harness-internal/runtime";

import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness connect --coordinator <https://host:port>";

/**
 * Thin route: parse, validate the coordinator origin is canonical HTTPS and
 * delegate. Remote discovery, OAuth and permission checks live in the runtime.
 */
export async function runConnectCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    { coordinator: { type: "string" } },
    USAGE,
  );
  if (positionals.length > 0) {
    throw usageError(`harness connect takes no positional arguments; usage: ${USAGE}`);
  }
  const coordinator = values["coordinator"];
  if (typeof coordinator !== "string" || coordinator === "") {
    throw usageError(`harness connect requires --coordinator <https://host:port>; usage: ${USAGE}`);
  }
  const normalized = normalizeCoordinatorOrigin(coordinator);
  if (normalized.status === "failed") {
    throw usageError(`${normalized.failure.summary}; usage: ${USAGE}`);
  }
  return context.runtime.connect({
    projectRoot: requireProjectRoot(context.cwd),
    coordinatorOrigin: normalized.origin,
  });
}
