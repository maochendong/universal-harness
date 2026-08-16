import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  createDshAgentAdapter,
  type DshProcessRunner,
} from "@universal-harness-internal/adapter-agent-dsh";
import type { RepositoryInspector } from "@universal-harness-internal/adapter-agent-command";
import { contentDigest, sha256Hex } from "@universal-harness-internal/core";
import type { OrchestrationExecutor } from "@universal-harness-internal/runtime";

import type { ProjectAgentConfig } from "./project-runtime-config.js";

function zeroSeparated(command: string, args: readonly string[], cwd: string): string[] {
  return execFileSync(command, [...args], { cwd, encoding: "utf8" })
    .split("\0")
    .filter((entry) => entry !== "");
}

/** Git-backed pre/post inspection used to detect writes outside the task scope. */
export function createGitRepositoryInspector(): RepositoryInspector {
  return {
    inspect(root) {
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      const changed = [
        ...zeroSeparated("git", ["diff", "--name-only", "-z", "HEAD", "--"], root),
        ...zeroSeparated("git", ["ls-files", "--others", "--exclude-standard", "-z"], root),
      ];
      const changedPaths = [...new Set(changed)].sort();
      const contents = changedPaths.map((path) => {
        const absolute = join(root, path);
        if (!existsSync(absolute)) return { path, digest: "missing" };
        if (!statSync(absolute).isFile()) return { path, digest: "non-file" };
        return { path, digest: sha256Hex(readFileSync(absolute).toString("base64")) };
      });
      return Promise.resolve({
        head,
        changed_paths: changedPaths,
        digest: contentDigest({ head, contents }),
      });
    },
  };
}

export interface ConfiguredAgentExecutorOptions {
  readonly inspector?: RepositoryInspector;
  readonly spawnProcess?: DshProcessRunner;
}

export interface ConfiguredAgentExecutor {
  readonly name: "agent-dsh";
  readonly execute: OrchestrationExecutor;
  readonly scope: {
    readonly allowed_read_paths: readonly string[];
    readonly proposed_write_paths: readonly string[];
  };
  readonly trajectoryVisibility: "full" | "summarized" | "external-only";
  readonly adapterProfile: ReturnType<typeof createDshAgentAdapter>["manifest"];
}

/** Build the project-selected real executor and its immutable task path scope. */
export function createConfiguredAgentExecutor(
  projectRoot: string,
  config: ProjectAgentConfig,
  options: ConfiguredAgentExecutorOptions = {},
): ConfiguredAgentExecutor {
  const adapter = createDshAgentAdapter({
    executable: config.executable,
    launcher_args: config.launcher_args,
    expected_version: config.expected_version,
    worktree: projectRoot,
    evidence_dir: join(projectRoot, ".harness", "raw-traces", "agent-dsh"),
    inspector: options.inspector ?? createGitRepositoryInspector(),
    env_allowlist: config.env_allowlist,
    ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
  });
  return {
    name: "agent-dsh",
    execute: (envelope) => adapter.run(envelope, { mode: "supervised" }),
    scope: {
      allowed_read_paths: config.allowed_read_paths,
      proposed_write_paths: config.proposed_write_paths,
    },
    trajectoryVisibility: adapter.manifest.trajectory_visibility,
    adapterProfile: adapter.manifest,
  };
}
