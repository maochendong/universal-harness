import { execFileSync } from "node:child_process";

import { backfillEvaluationGraph } from "@universal-harness-internal/runtime";

import { commandFailed, usageError } from "../../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../../io.js";
import type { CommandContext } from "../../router.js";

const USAGE = "harness graph backfill-evaluations";

/** Materialize graph verdict links from already-committed evaluation reports. */
export async function runGraphBackfillEvaluationsCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness graph backfill-evaluations takes no arguments; usage: ${USAGE}`);
  }
  const projectRoot = requireProjectRoot(context.cwd);
  try {
    const result = await backfillEvaluationGraph({
      projectRoot,
      readBaseline: () =>
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: projectRoot,
          encoding: "utf8",
        }).trim(),
    });
    return {
      command: "graph backfill-evaluations",
      status: result.skipped.length > 0 ? "failed" : "ok",
      message:
        `evaluation graph backfill processed ${String(result.evaluations)} report(s): ` +
        `${String(result.nodes)} node(s), ${String(result.edges)} edge(s) added`,
      data: {
        project_root: projectRoot,
        evaluations: result.evaluations,
        nodes_added: result.nodes,
        edges_added: result.edges,
        skipped: [...result.skipped],
      },
    };
  } catch (error) {
    throw commandFailed(error instanceof Error ? error.message : String(error));
  }
}
