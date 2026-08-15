import { execFileSync } from "node:child_process";

import { reconcileProjectGraph } from "@universal-harness-internal/runtime";

import { commandFailed, usageError } from "../../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../../io.js";
import type { CommandContext } from "../../router.js";

const USAGE = "harness graph reconcile";

/** Repair historical graph closure gaps without rewriting existing records. */
export async function runGraphReconcileCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness graph reconcile takes no arguments; usage: ${USAGE}`);
  }
  const projectRoot = requireProjectRoot(context.cwd);
  try {
    const result = await reconcileProjectGraph({
      projectRoot,
      readBaseline: () =>
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: projectRoot,
          encoding: "utf8",
        }).trim(),
    });
    return {
      command: "graph reconcile",
      status: result.skipped.length === 0 ? "ok" : "failed",
      message:
        `graph reconciliation added ${String(result.nodes)} node(s), ` +
        `${String(result.edges)} edge(s), ${String(result.revisions)} revision(s)`,
      data: {
        project_root: projectRoot,
        nodes_added: result.nodes,
        edges_added: result.edges,
        revisions_added: result.revisions,
        runs_linked: result.runs_linked,
        evaluations_added: result.evaluations,
        evidence_links_added: result.evidence_links,
        findings_created: result.findings_created,
        findings_superseded: result.findings_superseded,
        block_edges_retired: result.block_edges_retired,
        skipped: [...result.skipped],
      },
    };
  } catch (error) {
    throw commandFailed(error instanceof Error ? error.message : String(error));
  }
}
