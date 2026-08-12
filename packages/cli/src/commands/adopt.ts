import { usageError } from "../errors.js";
import { parseCommandArgs, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness adopt [path] --intent <text>";

/** Thin route: parse and delegate to the runtime service; no logic here. */
export async function runAdoptCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(args, { intent: { type: "string" } }, USAGE);
  const [path, extra] = positionals;
  if (extra !== undefined) {
    throw usageError(`expected at most one project path; usage: ${USAGE}`);
  }
  const intent = values["intent"];
  if (typeof intent !== "string" || intent.length === 0) {
    throw usageError(`harness adopt requires --intent <text>; usage: ${USAGE}`);
  }
  return context.runtime.adoptProject({ path: path ?? ".", intent });
}
