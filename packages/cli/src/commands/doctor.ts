import {
  collectDoctorProbes,
  evaluateDoctorDiagnostics,
} from "@universal-harness-internal/runtime";

import { usageError } from "../errors.js";
import { parseCommandArgs, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness doctor";

/**
 * Diagnose environment, Git, schema, pack, adapter and cache health (design
 * 11.2). The runtime owns every check; the handler gathers probes and renders
 * the typed diagnostics. Exits non-zero when any check fails.
 */
export function runDoctorCommand(args: readonly string[], context: CommandContext): CommandResult {
  const { positionals } = parseCommandArgs(args, {}, USAGE);
  if (positionals.length > 0) {
    throw usageError(`harness doctor takes no arguments; usage: ${USAGE}`);
  }
  const probes = collectDoctorProbes(context.cwd, { gitVersion: context.gitVersion });
  const report = evaluateDoctorDiagnostics(probes);
  return {
    command: "doctor",
    status: report.ok ? "ok" : "failed",
    message: report.ok
      ? `all ${report.diagnostics.length} checks passed (${report.warnings} warnings)`
      : `${report.failed} of ${report.diagnostics.length} checks failed`,
    data: {
      checks: report.diagnostics,
      failed_checks: report.failed,
      warning_checks: report.warnings,
    },
  };
}
