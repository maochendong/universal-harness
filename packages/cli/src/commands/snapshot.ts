import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness snapshot";

/** Thin route: parse, locate the managed project and delegate. */
export async function runSnapshotCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness snapshot takes no arguments; usage: ${USAGE}`);
  }
  return context.runtime.snapshot({ projectRoot: requireProjectRoot(context.cwd) });
}
