import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness resume <workflow-operation-id>";

/** Thin route: parse, locate the managed project and delegate. */
export async function runResumeCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  const [workflowOperationId, extra] = positionals;
  if (workflowOperationId === undefined || extra !== undefined) {
    throw usageError(`expected exactly one workflow operation id; usage: ${USAGE}`);
  }
  return context.runtime.resume({
    workflowOperationId,
    projectRoot: requireProjectRoot(context.cwd),
  });
}
