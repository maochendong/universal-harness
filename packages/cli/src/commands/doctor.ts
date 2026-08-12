import {
  GRAPH_DATABASE_RELATIVE_PATH,
  findProjectRoot,
  harnessRootFor,
  readManagedManifest,
  readManagedPackLock,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import { checkGraphCache } from "@universal-harness-internal/graph";

import { usageError } from "../errors.js";
import { parseCommandArgs, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness doctor";
const MINIMUM_NODE_MAJOR = 22;

export interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

function checkNodeRuntime(): DoctorCheck {
  const version = process.version;
  const major = Number(/^v(\d+)/u.exec(version)?.[1] ?? 0);
  return {
    name: "node_runtime",
    status: major >= MINIMUM_NODE_MAJOR ? "pass" : "fail",
    detail: `${version} (requires >= ${MINIMUM_NODE_MAJOR}.13.0)`,
  };
}

function checkGit(context: CommandContext): DoctorCheck {
  const version = context.gitVersion();
  return {
    name: "git_executable",
    status: version === undefined ? "fail" : "pass",
    detail: version ?? "git executable not found on PATH",
  };
}

function projectChecks(cwd: string): DoctorCheck[] {
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot === undefined) {
    return [
      {
        name: "project_layout",
        status: "pass",
        detail: "no managed project at or above the working directory (project checks skipped)",
      },
    ];
  }
  const checks: DoctorCheck[] = [];
  try {
    const manifest = readManagedManifest(projectRoot);
    checks.push({
      name: "project_layout",
      status: "pass",
      detail: `project ${manifest.name} at ${projectRoot}`,
    });
  } catch (error) {
    checks.push({
      name: "project_layout",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const lock = readManagedPackLock(projectRoot);
    checks.push({
      name: "pack_lock",
      status: "pass",
      detail: `${lock.packs.length} pinned packs`,
    });
  } catch (error) {
    checks.push({
      name: "pack_lock",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const cache = checkGraphCache(
    resolveHarnessPath(harnessRootFor(projectRoot), GRAPH_DATABASE_RELATIVE_PATH),
  );
  checks.push({
    name: "graph_cache",
    status: cache.status === "corrupt" || cache.status === "inconsistent" ? "fail" : "pass",
    detail: cache.detail === undefined ? cache.status : `${cache.status}: ${cache.detail}`,
  });
  return checks;
}

/** Diagnose environment, Git, managed layout and cache health. */
export function runDoctorCommand(args: readonly string[], context: CommandContext): CommandResult {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness doctor takes no arguments; usage: ${USAGE}`);
  }
  const checks = [checkNodeRuntime(), checkGit(context), ...projectChecks(context.cwd)];
  const failed = checks.filter((check) => check.status === "fail");
  return {
    command: "doctor",
    status: failed.length === 0 ? "ok" : "failed",
    message:
      failed.length === 0
        ? `all ${checks.length} checks passed`
        : `${failed.length} of ${checks.length} checks failed`,
    data: { checks, failed_checks: failed.length },
  };
}
