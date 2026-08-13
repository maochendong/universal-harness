import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness run [--dry-run]";

/** Thin route: parse, locate the managed project and delegate. */
export async function runRunCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(args, { "dry-run": { type: "boolean" } }, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness run takes no positional arguments; usage: ${USAGE}`);
  }
  return context.runtime.run({
    projectRoot: requireProjectRoot(context.cwd),
    dryRun: values["dry-run"] === true,
  });
}
