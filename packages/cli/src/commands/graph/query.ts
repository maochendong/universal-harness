import { DatabaseSync } from "node:sqlite";

import {
  GRAPH_DATABASE_RELATIVE_PATH,
  NODE_TYPES,
  harnessRootFor,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import { MAX_PAGE_LIMIT, checkGraphCache, pageNodes } from "@universal-harness-internal/graph";

import { commandFailed, usageError } from "../../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../../io.js";
import type { CommandContext } from "../../router.js";

const USAGE = "harness graph query [--type <node-type>] [--limit <n>] [--cursor <cursor>]";

/** Read-only query over the materialized graph cache. */
export function runGraphQueryCommand(
  args: readonly string[],
  context: CommandContext,
): CommandResult {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      type: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
    },
    USAGE,
  );
  if (positionals.length > 0) {
    throw usageError(`harness graph query takes no positional arguments; usage: ${USAGE}`);
  }
  const typeValue = values["type"];
  if (typeValue !== undefined && typeof typeValue !== "string") {
    throw usageError(`--type requires a value; usage: ${USAGE}`);
  }
  if (typeValue !== undefined && !(NODE_TYPES as readonly string[]).includes(typeValue)) {
    throw usageError(`unknown node type: ${typeValue}; expected one of ${NODE_TYPES.join(", ")}`);
  }
  const rawLimit = values["limit"];
  if (rawLimit !== undefined && typeof rawLimit !== "string") {
    throw usageError(`--limit requires a value; usage: ${USAGE}`);
  }
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw usageError(`--limit must be an integer in 1..${MAX_PAGE_LIMIT}`);
    }
  }
  const cursor = values["cursor"];
  if (cursor !== undefined && typeof cursor !== "string") {
    throw usageError(`--cursor requires a value; usage: ${USAGE}`);
  }
  const projectRoot = requireProjectRoot(context.cwd);
  const databasePath = resolveHarnessPath(
    harnessRootFor(projectRoot),
    GRAPH_DATABASE_RELATIVE_PATH,
  );
  const cache = checkGraphCache(databasePath);
  if (cache.status !== "ok") {
    throw commandFailed(`graph cache is ${cache.status}; run harness graph sync first`, {
      cache_status: cache.status,
    });
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const page = pageNodes(database, {
      ...(typeValue === undefined ? {} : { type: typeValue as (typeof NODE_TYPES)[number] }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return {
      command: "graph query",
      status: "ok",
      message: `${page.items.length} nodes`,
      data: {
        project_root: projectRoot,
        count: page.items.length,
        nodes: page.items,
        ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
      },
    };
  } finally {
    database.close();
  }
}
