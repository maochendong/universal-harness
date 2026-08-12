import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  readCommittedOperations,
  readManagedManifest,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import { checkGraphCache } from "@universal-harness-internal/graph";

import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import { usageError } from "../errors.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness status";

/** Project state shell view: identity, ledger size and cache health. */
export function runStatusCommand(args: readonly string[], context: CommandContext): CommandResult {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness status takes no arguments; usage: ${USAGE}`);
  }
  const projectRoot = requireProjectRoot(context.cwd);
  const harnessRoot = harnessRootFor(projectRoot);
  const manifest = readManagedManifest(projectRoot);
  const operations = readCommittedOperations(harnessRoot);
  const cache = checkGraphCache(resolveHarnessPath(harnessRoot, GRAPH_DATABASE_RELATIVE_PATH));
  const lastOperation = operations.at(-1)?.manifest.ledger_operation_id ?? "none";
  return {
    command: "status",
    status: "ok",
    message: `project ${manifest.name}: ${operations.length} committed operations, graph cache ${cache.status}`,
    data: {
      project_root: projectRoot,
      name: manifest.name,
      repository_id: manifest.repository_id,
      committed_operations: operations.length,
      last_ledger_operation: lastOperation,
      graph_cache: cache.status,
    },
  };
}
