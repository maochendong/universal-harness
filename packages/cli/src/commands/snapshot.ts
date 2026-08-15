import { execFileSync } from "node:child_process";

import { SnapshotAnchorError, anchorSnapshot } from "@universal-harness-internal/runtime";

import { commandFailed, usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE = "harness snapshot [anchor <snapshot-id> --source-commit <sha> --reason <text>]";

/** Thin route: parse, locate the managed project and delegate. */
export async function runSnapshotCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      "source-commit": { type: "string" },
      reason: { type: "string" },
    },
    USAGE,
  );
  if (positionals[0] === "anchor") {
    const snapshotId = positionals[1];
    const sourceCommit = values["source-commit"];
    const reason = values.reason;
    if (
      positionals.length !== 2 ||
      snapshotId === undefined ||
      typeof sourceCommit !== "string" ||
      typeof reason !== "string"
    ) {
      throw usageError(
        `snapshot anchor requires an id, --source-commit and --reason; usage: ${USAGE}`,
      );
    }
    const projectRoot = requireProjectRoot(context.cwd);
    try {
      const result = await anchorSnapshot({
        projectRoot,
        snapshotId,
        sourceCommit,
        reason,
        actor: "human:local",
        readBaseline: () =>
          execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: projectRoot,
            encoding: "utf8",
          }).trim(),
      });
      return {
        command: "snapshot anchor",
        status: "ok",
        message:
          result.status === "created"
            ? `snapshot ${snapshotId} anchored to ${result.correction.corrected_source_commit.slice(0, 12)}`
            : `snapshot ${snapshotId} was already anchored to ${result.correction.corrected_source_commit.slice(0, 12)}`,
        data: {
          project_root: projectRoot,
          status: result.status,
          snapshot_id: snapshotId,
          source_commit: result.correction.corrected_source_commit,
          code_digest: result.correction.code_digest,
          correction_digest: result.correction.digest,
        },
      };
    } catch (error) {
      if (error instanceof SnapshotAnchorError) {
        throw commandFailed(error.message, { kind: error.kind });
      }
      throw error;
    }
  }
  if (
    positionals.length > 0 ||
    values["source-commit"] !== undefined ||
    values.reason !== undefined
  ) {
    throw usageError(`harness snapshot takes no arguments unless using anchor; usage: ${USAGE}`);
  }
  return context.runtime.snapshot({ projectRoot: requireProjectRoot(context.cwd) });
}
