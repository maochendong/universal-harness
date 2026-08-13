import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness eval";

/** Thin route: parse, locate the managed project and delegate. */
export async function runEvalCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness eval takes no arguments; usage: ${USAGE}`);
  }
  return context.runtime.evaluate({ projectRoot: requireProjectRoot(context.cwd) });
}
