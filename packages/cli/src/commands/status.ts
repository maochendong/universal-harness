import { collectProjectStatus } from "@universal-harness-internal/runtime";

import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import { usageError } from "../errors.js";
import type { CommandContext, SchedulerStatusView } from "../router.js";

const USAGE = "harness status";

/**
 * Chinese one-line scheduler facet for human mode (M4 design 19.3); the
 * read-model digest and machine fields stay JSON-only.
 */
function renderSchedulerFacetZh(view: SchedulerStatusView): string {
  if (view.capability_status === "inactive_by_profile") {
    return "调度：当前 profile 未启用并行调度";
  }
  const waves =
    view.waves === undefined
      ? "波次未知"
      : `波次 ${String(view.waves.integrated)}/${String(view.waves.total)} 已集成`;
  const live = view.live_state === "rebuilding" ? "实时投影重建中" : "实时投影正常";
  const next = view.next_action === undefined ? "无待办" : `下一动作：${view.next_action}`;
  return `调度：${waves}，${live}，${next}`;
}

/**
 * Project state view (design 11.2): identity, ledger size, cache health plus
 * the derived facets -- iteration state, blockers, stale evidence, pending
 * approvals, evaluation coverage, budget and next action. All derivation
 * lives in the runtime; the handler only adapts the report to CommandResult.
 */
export async function runStatusCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness status takes no arguments; usage: ${USAGE}`);
  }
  const projectRoot = requireProjectRoot(context.cwd);
  const status = collectProjectStatus(projectRoot);
  // Remote collaboration summary (design section 18.1): undefined unless the
  // project has an active connection, so never-connected projects keep the
  // exact pre-M3 output.
  const remote = await context.runtime.remoteSummary?.({ projectRoot });
  // Scheduler facet (M4 design 19.2/19.3): undefined unless the project
  // composes a scheduler host and an open operation exists, so unconfigured
  // projects keep the exact pre-M4 output. Read-only; never acquires the lock.
  const scheduler = await context.runtime.schedulerStatus?.({ projectRoot });
  const openGroups = status.finding_groups.filter((group) => group.open_count > 0);
  const nextAction =
    openGroups.length > 0 && /(?:blocking|warning) finding /u.test(status.next_action)
      ? `review finding group ${openGroups[0]?.group_id ?? "unknown"}`
      : status.next_action;
  const data: Record<string, unknown> = context.json
    ? {
        ...status,
        ...(remote === undefined ? {} : { collaboration: remote }),
        ...(scheduler === undefined ? {} : { scheduler }),
      }
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
        ...(remote === undefined ? {} : { collaboration: remote }),
        ...(scheduler === undefined
          ? {}
          : {
              scheduler: renderSchedulerFacetZh(scheduler),
              ...(scheduler.blockers.length === 0
                ? {}
                : {
                    scheduler_blockers: scheduler.blockers.map(
                      (blocker) =>
                        `阻断 ${blocker.finding_id}：恢复动作 ${blocker.recovery_action}`,
                    ),
                  }),
            }),
      };
  return {
    command: "status",
    status: "ok",
    message: `project ${status.name}: ${status.committed_operations} committed operations, graph cache ${status.graph_cache}; next: ${nextAction}`,
    data,
  };
}
