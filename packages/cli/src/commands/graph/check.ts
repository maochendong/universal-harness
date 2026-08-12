import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import {
  GraphIntegrityError,
  MaterializationError,
  checkGraphCache,
  materializeLedger,
  type IntegrityViolation,
} from "@universal-harness-internal/graph";

import { usageError } from "../../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../../io.js";
import type { CommandContext } from "../../router.js";

const USAGE = "harness graph check";

/**
 * Verify ledger integrity invariants and cache consistency. Materializing
 * into an ephemeral in-memory database re-runs the full integrity gate over
 * the authoritative ledger without touching the on-disk cache; any violation
 * blocks with a typed failure instead of being merged away.
 */
export function runGraphCheckCommand(
  args: readonly string[],
  context: CommandContext,
): CommandResult {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness graph check takes no arguments; usage: ${USAGE}`);
  }
  const projectRoot = requireProjectRoot(context.cwd);
  const cache = checkGraphCache(
    resolveHarnessPath(harnessRootFor(projectRoot), GRAPH_DATABASE_RELATIVE_PATH),
  );
  let violations: readonly IntegrityViolation[] = [];
  let ledgerError: string | undefined;
  try {
    const materialization = materializeLedger({ projectRoot, databasePath: ":memory:" });
    materialization.database.close();
  } catch (error) {
    if (error instanceof GraphIntegrityError) {
      violations = error.violations;
    } else if (error instanceof MaterializationError) {
      ledgerError = error.message;
    } else {
      throw error;
    }
  }
  const cacheBlocking =
    cache.status === "corrupt" ||
    cache.status === "inconsistent" ||
    cache.status === "unsupported_version";
  const failed = violations.length > 0 || ledgerError !== undefined || cacheBlocking;
  return {
    command: "graph check",
    status: failed ? "failed" : "ok",
    message: failed
      ? "graph check blocked; resolve the reported violations explicitly"
      : "ledger integrity and cache consistency verified",
    data: {
      project_root: projectRoot,
      graph_cache: cache.status,
      integrity_violations: violations.length,
      violations,
      ...(ledgerError === undefined ? {} : { ledger_error: ledgerError }),
    },
  };
}
