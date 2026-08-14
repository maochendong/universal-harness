import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE =
  "harness finding <accept|close|supersede> <finding-id> [--evidence <id>] [--actor <id>]";

const ACTIONS = ["accept", "close", "supersede"] as const;

/** Thin route: parse, locate the managed project and delegate. */
export async function runFindingCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    { evidence: { type: "string" }, actor: { type: "string" } },
    USAGE,
  );
  const [action, findingId, extra] = positionals;
  if (
    action === undefined ||
    findingId === undefined ||
    extra !== undefined ||
    !(ACTIONS as readonly string[]).includes(action)
  ) {
    throw usageError(`expected an action and a finding id; usage: ${USAGE}`);
  }
  const evidence = values["evidence"];
  const actor = values["actor"];
  return context.runtime.finding({
    action: action as (typeof ACTIONS)[number],
    findingId,
    projectRoot: requireProjectRoot(context.cwd),
    ...(typeof evidence === "string" ? { evidenceId: evidence } : {}),
    ...(typeof actor === "string" ? { actor } : {}),
  });
}
