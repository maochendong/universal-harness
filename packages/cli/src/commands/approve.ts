import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness approve <request-id> --decision <approve|reject|defer>";

const DECISIONS = ["approve", "reject", "defer"] as const;

/** Thin route: parse, locate the managed project and delegate. */
export async function runApproveCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    { decision: { type: "string" }, actor: { type: "string" } },
    USAGE,
  );
  const [requestId, extra] = positionals;
  if (requestId === undefined || extra !== undefined) {
    throw usageError(`expected exactly one approval request id; usage: ${USAGE}`);
  }
  const decision = values["decision"];
  if (typeof decision !== "string" || !(DECISIONS as readonly string[]).includes(decision)) {
    throw usageError(`harness approve requires --decision <approve|reject|defer>; usage: ${USAGE}`);
  }
  const actor = values["actor"];
  return context.runtime.approve({
    requestId,
    decision: decision as (typeof DECISIONS)[number],
    projectRoot: requireProjectRoot(context.cwd),
    ...(typeof actor === "string" ? { actor } : {}),
  });
}
