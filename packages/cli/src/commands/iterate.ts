import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness iterate <text> [--profile <lite|standard|governed>]";

/** Thin route: parse, locate the managed project and delegate. */
export async function runIterateCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(args, { profile: { type: "string" } }, USAGE);
  const [text, extra] = positionals;
  if (text === undefined || extra !== undefined) {
    throw usageError(`expected exactly one change description; usage: ${USAGE}`);
  }
  const profile = values["profile"];
  return context.runtime.iterate({
    text,
    projectRoot: requireProjectRoot(context.cwd),
    ...(typeof profile === "string" ? { profile } : {}),
  });
}
