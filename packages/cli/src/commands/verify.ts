import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness verify";

/** Thin route: parse, locate the managed project and delegate. */
export async function runVerifyCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness verify takes no arguments; usage: ${USAGE}`);
  }
  return context.runtime.verify({ projectRoot: requireProjectRoot(context.cwd) });
}
