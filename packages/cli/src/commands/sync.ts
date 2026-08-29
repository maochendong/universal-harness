import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness sync";

/** Thin route: the runtime polls the coordinator and rebuilds the projection. */
export async function runSyncCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness sync takes no arguments; usage: ${USAGE}`);
  }
  return context.runtime.sync({ projectRoot: requireProjectRoot(context.cwd) });
}
