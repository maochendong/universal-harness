import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness abort <workflow-operation-id>";

/** Thin route: parse, locate the managed project and delegate. */
export async function runAbortCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(args, { actor: { type: "string" } }, USAGE);
  const [workflowOperationId, extra] = positionals;
  if (workflowOperationId === undefined || extra !== undefined) {
    throw usageError(`expected exactly one workflow operation id; usage: ${USAGE}`);
  }
  const actor = values["actor"];
  return context.runtime.abort({
    workflowOperationId,
    projectRoot: requireProjectRoot(context.cwd),
    ...(typeof actor === "string" ? { actor } : {}),
  });
}
