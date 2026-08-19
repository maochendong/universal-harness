import { usageError } from "../errors.js";
import { parseCommandArgs, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness new <name> --intent <text> [--profile <lite|standard|governed>]";

/** Thin route: parse and delegate to the runtime service; no logic here. */
export async function runNewCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    { intent: { type: "string" }, profile: { type: "string" } },
    USAGE,
  );
  const [name, extra] = positionals;
  if (name === undefined || extra !== undefined) {
    throw usageError(`expected exactly one project name; usage: ${USAGE}`);
  }
  const intent = values["intent"];
  if (typeof intent !== "string" || intent.length === 0) {
    throw usageError(`harness new requires --intent <text>; usage: ${USAGE}`);
  }
  const profile = values["profile"];
  return context.runtime.newProject({
    name,
    intent,
    ...(typeof profile === "string" ? { profile } : {}),
  });
}
