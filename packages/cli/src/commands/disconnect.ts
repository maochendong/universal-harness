import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness disconnect";

/** Thin route: the runtime blocks new leases and appends the disconnected record. */
export async function runDisconnectCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness disconnect takes no arguments; usage: ${USAGE}`);
  }
  return context.runtime.disconnect({ projectRoot: requireProjectRoot(context.cwd) });
}
