import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { renderTasksProjection } from "@universal-harness-internal/adapter-projection-markdown";
import { harnessRootFor, type EdgeRecord, type NodeRecord } from "@universal-harness-internal/core";
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";
import { planManagedWrite, writeManagedOutput } from "@universal-harness-internal/runtime";

import { commandFailed, usageError } from "../../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../../io.js";
import type { CommandContext } from "../../router.js";

const USAGE = "harness graph project-tasks [--approve-overwrite]";

function completedTaskIds(projectRoot: string): string[] {
  const root = join(harnessRootFor(projectRoot), "artifacts", "snapshots");
  if (!existsSync(root)) return [];
  const completed = new Set<string>();
  for (const name of readdirSync(root)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const snapshot = JSON.parse(readFileSync(join(root, name), "utf8")) as {
      run_outcomes?: readonly { readonly id?: unknown; readonly outcome?: unknown }[];
    };
    for (const outcome of snapshot.run_outcomes ?? []) {
      if (
        outcome.outcome === "success" &&
        typeof outcome.id === "string" &&
        outcome.id.startsWith("task_")
      ) {
        completed.add(outcome.id);
      }
    }
  }
  return [...completed].sort();
}

/** Deterministically rebuild the SpecKit-style Task projection from the ledger graph. */
export function runGraphProjectTasksCommand(
  args: readonly string[],
  context: CommandContext,
): CommandResult {
  const { values, positionals } = parseCommandArgs(
    args,
    { "approve-overwrite": { type: "boolean" } },
    USAGE,
  );
  if (positionals.length > 0) {
    throw usageError(`harness graph project-tasks takes no arguments; usage: ${USAGE}`);
  }
  const projectRoot = requireProjectRoot(context.cwd);
  const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
  const nodes: NodeRecord[] = [];
  const edges: EdgeRecord[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = pageNodes(database, {
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      nodes.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    let edgeCursor: string | undefined;
    do {
      const page = pageEdges(database, {
        limit: 500,
        ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
      });
      edges.push(...page.items);
      edgeCursor = page.nextCursor;
    } while (edgeCursor !== undefined);
  } finally {
    database.close();
  }
  const projection = renderTasksProjection(
    { nodes, edges },
    { completedTasks: completedTaskIds(projectRoot) },
  );
  const output = { name: "views/tasks.md", content: projection.markdown };
  const plan = planManagedWrite(harnessRootFor(projectRoot), output);
  if (plan.action === "rewrite" && values["approve-overwrite"] !== true) {
    throw commandFailed(
      `projection rewrite requires --approve-overwrite; existing digest ${plan.existing_digest ?? "unknown"}, generated digest ${plan.digest}`,
      { plan },
    );
  }
  const written = writeManagedOutput(harnessRootFor(projectRoot), output, {
    overwriteApproved: values["approve-overwrite"] === true,
  });
  return {
    command: "graph project-tasks",
    status: "ok",
    message: `tasks projection ${written.action}: ${written.relativePath}`,
    data: { project_root: projectRoot, ...written },
  };
}
