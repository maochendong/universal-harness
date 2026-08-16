import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE =
  "harness finding <accept|close|supersede> <finding-id> [--evidence <id>] [--actor <id>] | harness finding group <accept|close|supersede> <group-id> --digest <membership-digest> [--evidence <id>] [--actor <id>]";

const ACTIONS = ["accept", "close", "supersede"] as const;

/** Thin route: parse, locate the managed project and delegate. */
export async function runFindingCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      digest: { type: "string" },
      evidence: { type: "string" },
      actor: { type: "string" },
    },
    USAGE,
  );
  if (positionals[0] === "group") {
    const [, action, groupId, extra] = positionals;
    const digest = values["digest"];
    if (
      action === undefined ||
      groupId === undefined ||
      extra !== undefined ||
      !(ACTIONS as readonly string[]).includes(action) ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(digest)
    ) {
      throw usageError(
        `group action requires a group id and 64-character --digest; usage: ${USAGE}`,
      );
    }
    const evidence = values["evidence"];
    const actor = values["actor"];
    return context.runtime.findingGroup({
      action: action as (typeof ACTIONS)[number],
      groupId,
      membershipDigest: digest,
      projectRoot: requireProjectRoot(context.cwd),
      ...(typeof evidence === "string" ? { evidenceId: evidence } : {}),
      ...(typeof actor === "string" ? { actor } : {}),
    });
  }
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
  if (values["digest"] !== undefined) {
    throw usageError(`--digest is only valid for finding group actions; usage: ${USAGE}`);
  }
  return context.runtime.finding({
    action: action as (typeof ACTIONS)[number],
    findingId,
    projectRoot: requireProjectRoot(context.cwd),
    ...(typeof evidence === "string" ? { evidenceId: evidence } : {}),
    ...(typeof actor === "string" ? { actor } : {}),
  });
}
