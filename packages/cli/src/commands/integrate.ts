import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness integrate <prepare <operation-id>|accept <integration-id>>";

/** Collaboration ids are `<kind>_<base>` identifiers; anything else is a usage error. */
const ID_PATTERN = /^[a-z][a-z0-9]*_[A-Za-z0-9]+$/u;

/**
 * Thin route: integration stays two explicit steps (prepare, then accept);
 * re-validation and the Target CAS live in the runtime coordinator.
 */
export async function runIntegrateCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  const [action, targetId, extra] = positionals;
  if (action !== "prepare" && action !== "accept") {
    throw usageError(
      `unknown integrate subcommand: ${action ?? "none"}; expected prepare or accept; usage: ${USAGE}`,
    );
  }
  if (targetId === undefined || extra !== undefined) {
    throw usageError(
      `harness integrate ${action} expects exactly one ${action === "prepare" ? "operation" : "integration"} id; usage: ${USAGE}`,
    );
  }
  if (!ID_PATTERN.test(targetId)) {
    throw usageError(`malformed ${action} target id: ${targetId}; usage: ${USAGE}`);
  }
  return context.runtime.integrate({
    projectRoot: requireProjectRoot(context.cwd),
    action,
    targetId,
  });
}
