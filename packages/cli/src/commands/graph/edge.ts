import {
  approveGraphEdge,
  graphEdgeId,
  proposeGraphEdge,
  GraphEditError,
} from "@universal-harness-internal/runtime";
import type { EdgeRecord } from "@universal-harness-internal/core";
import { execFileSync } from "node:child_process";

import { commandFailed, usageError } from "../../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../../io.js";
import type { CommandContext } from "../../router.js";

const PROPOSE_USAGE = "harness graph propose-edge --type <relation> --source <id> --target <id>";
const APPROVE_USAGE = "harness graph approve-edge <edge-id> --digest <preview-digest>";

function editDeps(projectRoot: string): {
  readonly projectRoot: string;
  readonly readBaseline: () => string;
} {
  return {
    projectRoot,
    readBaseline: () =>
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
  };
}

function asResult(error: unknown): never {
  if (error instanceof GraphEditError) {
    throw commandFailed(error.message, { kind: error.kind });
  }
  throw error;
}

/** Stage one human-driven edge proposal (approval binds its digest). */
export async function runGraphProposeEdgeCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      type: { type: "string" },
      source: { type: "string" },
      target: { type: "string" },
      actor: { type: "string" },
    },
    PROPOSE_USAGE,
  );
  if (positionals.length > 0) {
    throw usageError(
      `harness graph propose-edge takes no positional arguments; usage: ${PROPOSE_USAGE}`,
    );
  }
  const type = values["type"];
  const source = values["source"];
  const target = values["target"];
  if (typeof type !== "string" || typeof source !== "string" || typeof target !== "string") {
    throw usageError(
      `propose-edge requires --type, --source and --target; usage: ${PROPOSE_USAGE}`,
    );
  }
  const actor = values["actor"];
  try {
    const proposed = await proposeGraphEdge(editDeps(requireProjectRoot(context.cwd)), {
      type: type as EdgeRecord["type"],
      sourceId: source,
      targetId: target,
      actor: typeof actor === "string" ? actor : "human:local",
    });
    return {
      command: "graph propose-edge",
      status: "ok",
      message:
        proposed.status === "already_present"
          ? `edge ${proposed.edgeId} already active`
          : `edge proposal ${proposed.edgeId} staged; approve with: harness graph approve-edge ${proposed.edgeId} --digest ${proposed.previewDigest}`,
      data: {
        status: proposed.status,
        edge_id: proposed.edgeId,
        preview_digest: proposed.previewDigest,
      },
    };
  } catch (error) {
    return asResult(error);
  }
}

/** Commit a staged edge proposal whose approval binds the exact digest. */
export async function runGraphApproveEdgeCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    { digest: { type: "string" }, actor: { type: "string" } },
    APPROVE_USAGE,
  );
  const [edgeId, extra] = positionals;
  if (edgeId === undefined || extra !== undefined) {
    throw usageError(`expected exactly one edge id; usage: ${APPROVE_USAGE}`);
  }
  const digest = values["digest"];
  if (typeof digest !== "string") {
    throw usageError(`approve-edge requires --digest <preview-digest>; usage: ${APPROVE_USAGE}`);
  }
  const actor = values["actor"];
  try {
    const approved = await approveGraphEdge(editDeps(requireProjectRoot(context.cwd)), {
      edgeId,
      previewDigest: digest,
      actor: typeof actor === "string" ? actor : "human:local",
    });
    return {
      command: "graph approve-edge",
      status: "ok",
      message:
        approved.status === "already_present"
          ? `edge ${approved.edgeId} already active`
          : `edge ${approved.edgeId} committed`,
      data: { status: approved.status, edge_id: approved.edgeId },
    };
  } catch (error) {
    return asResult(error);
  }
}

export { graphEdgeId };
