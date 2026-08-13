import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness impact [node-id]";

/** Thin route: parse, locate the managed project and delegate. */
export async function runImpactCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  const [target, extra] = positionals;
  if (extra !== undefined) {
    throw usageError(`expected at most one seed node id; usage: ${USAGE}`);
  }
  return context.runtime.impact({
    projectRoot: requireProjectRoot(context.cwd),
    ...(target === undefined ? {} : { target }),
  });
}
