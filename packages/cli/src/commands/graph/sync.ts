import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import { rebuildGraphCache } from "@universal-harness-internal/graph";

import { usageError } from "../../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../../io.js";
import type { CommandContext } from "../../router.js";

const USAGE = "harness graph sync";

/** Rebuild the disposable SQLite cache from the authoritative Git ledger. */
export function runGraphSyncCommand(
  args: readonly string[],
  context: CommandContext,
): CommandResult {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness graph sync takes no arguments; usage: ${USAGE}`);
  }
  const projectRoot = requireProjectRoot(context.cwd);
  const databasePath = resolveHarnessPath(
    harnessRootFor(projectRoot),
    GRAPH_DATABASE_RELATIVE_PATH,
  );
  const rebuild = rebuildGraphCache({ projectRoot, databasePath });
  try {
    const { report } = rebuild;
    return {
      command: "graph sync",
      status: "ok",
      message: `graph cache rebuilt: ${report.nodeCount} nodes, ${report.edgeCount} edges, ${report.eventCount} events`,
      data: {
        project_root: projectRoot,
        database_path: databasePath,
        recovered_from: rebuild.recoveredFrom,
        operations: report.operationCount,
        nodes: report.nodeCount,
        edges: report.edgeCount,
        events: report.eventCount,
        last_sequence: report.lastSequence,
        skipped_artifacts: report.skippedArtifacts.length,
        projection_digest: report.projectionDigest,
      },
    };
  } finally {
    rebuild.database.close();
  }
}
