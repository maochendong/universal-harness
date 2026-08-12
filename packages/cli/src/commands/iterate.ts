import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness iterate <text>";

/** Thin route: parse, locate the managed project and delegate. */
export async function runIterateCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  const [text, extra] = positionals;
  if (text === undefined || extra !== undefined) {
    throw usageError(`expected exactly one change description; usage: ${USAGE}`);
  }
  return context.runtime.iterate({ text, projectRoot: requireProjectRoot(context.cwd) });
}
