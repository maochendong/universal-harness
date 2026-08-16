import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness serve [--port <0..65535>]";

export async function runServeCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(args, { port: { type: "string" } }, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness serve takes no positional arguments; usage: ${USAGE}`);
  }
  const rawPort = values["port"];
  if (rawPort !== undefined && !/^(?:0|[1-9][0-9]{0,4})$/u.test(String(rawPort))) {
    throw usageError(`--port must be an integer in 0..65535; usage: ${USAGE}`);
  }
  const port = rawPort === undefined ? 0 : Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw usageError(`--port must be an integer in 0..65535; usage: ${USAGE}`);
  }
  return context.runtime.serve({ projectRoot: requireProjectRoot(context.cwd), port });
}
