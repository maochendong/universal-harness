import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness resume <workflow-operation-id> [--profile <lite|standard|governed>]";

/** Thin route: parse, locate the managed project and delegate. */
export async function runResumeCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(args, { profile: { type: "string" } }, USAGE);
  const [workflowOperationId, extra] = positionals;
  if (workflowOperationId === undefined || extra !== undefined) {
    throw usageError(`expected exactly one workflow operation id; usage: ${USAGE}`);
  }
  const profile = values["profile"];
  return context.runtime.resume({
    workflowOperationId,
    projectRoot: requireProjectRoot(context.cwd),
    ...(typeof profile === "string" ? { profile } : {}),
  });
}
