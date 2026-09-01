import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness run [--dry-run] [--max-concurrency <n>]";

/**
 * `--max-concurrency <n>` (M4 design 20): a positive-integer local request,
 * never authority — the effective concurrency is clamped by Profile/Policy
 * ceilings at drive time.
 */
export function parseMaxConcurrency(raw: string, usage: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw usageError(`--max-concurrency must be a positive integer; usage: ${usage}`);
  }
  return parsed;
}

/** Thin route: parse, locate the managed project and delegate. */
export async function runRunCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    { "dry-run": { type: "boolean" }, "max-concurrency": { type: "string" } },
    USAGE,
  );
  if (positionals.length > 0) {
    throw usageError(`harness run takes no positional arguments; usage: ${USAGE}`);
  }
  const maxConcurrency = values["max-concurrency"];
  return context.runtime.run({
    projectRoot: requireProjectRoot(context.cwd),
    dryRun: values["dry-run"] === true,
    ...(typeof maxConcurrency === "string"
      ? { maxConcurrency: parseMaxConcurrency(maxConcurrency, USAGE) }
      : {}),
  });
}
