import { collectProjectStatus } from "@universal-harness-internal/runtime";

import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import { usageError } from "../errors.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness status";

/**
 * Project state view (design 11.2): identity, ledger size, cache health plus
 * the derived facets -- iteration state, blockers, stale evidence, pending
 * approvals, evaluation coverage, budget and next action. All derivation
 * lives in the runtime; the handler only adapts the report to CommandResult.
 */
export function runStatusCommand(args: readonly string[], context: CommandContext): CommandResult {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness status takes no arguments; usage: ${USAGE}`);
  }
  const projectRoot = requireProjectRoot(context.cwd);
  const status = collectProjectStatus(projectRoot);
  const openGroups = status.finding_groups.filter((group) => group.open_count > 0);
  const nextAction =
    openGroups.length > 0 && /(?:blocking|warning) finding /u.test(status.next_action)
      ? `review finding group ${openGroups[0]?.group_id ?? "unknown"}`
      : status.next_action;
  const data: Record<string, unknown> = context.json
    ? { ...status }
    : {
        ...Object.fromEntries(
          Object.entries(status).filter(
            ([key]) => key !== "blockers" && key !== "warnings" && key !== "finding_groups",
          ),
        ),
        ...(status.blockers.filter((blocker) => !/^blocking finding /u.test(blocker)).length === 0
          ? {}
          : {
              blockers: status.blockers.filter((blocker) => !/^blocking finding /u.test(blocker)),
            }),
        finding_group_count: openGroups.length,
        finding_groups: openGroups,
        next_action: nextAction,
      };
  return {
    command: "status",
    status: "ok",
    message: `project ${status.name}: ${status.committed_operations} committed operations, graph cache ${status.graph_cache}; next: ${nextAction}`,
    data,
  };
}
