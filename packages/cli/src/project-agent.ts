import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  createDshAgentAdapter,
  type DshProcessRunner,
} from "@universal-harness-internal/adapter-agent-dsh";
import type { RepositoryInspector } from "@universal-harness-internal/adapter-agent-command";
import { contentDigest, sha256Hex } from "@universal-harness-internal/core";
import type { AgentSlotFactory, OrchestrationExecutor } from "@universal-harness-internal/runtime";
import {
  assessUnattendedEligibility,
  type AgentProviderManifest,
} from "@universal-harness-internal/plugin-sdk";

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
    execute: (envelope, runOptions) =>
      adapter.run(envelope, {
        mode: "supervised",
        ...(runOptions?.onOutput === undefined ? {} : { on_output: runOptions.onOutput }),
      }),
    scope: {
      allowed_read_paths: config.allowed_read_paths,
      proposed_write_paths: config.proposed_write_paths,
    },
    trajectoryVisibility: adapter.manifest.trajectory_visibility,
    adapterProfile: adapter.manifest,
  };
}

/**
 * Construction context for the project AgentSlotFactory: the managed project
 * root, its committed agent configuration and the injectable process seams
 * (tests stay hermetic through the same spawn/inspector ports the sequential
 * executor uses).
 */
export interface ProjectAgentContext {
  readonly projectRoot: string;
  readonly config: ProjectAgentConfig;
  readonly inspector?: RepositoryInspector;
  readonly spawnProcess?: DshProcessRunner;
}

/**
 * The M4 slot-factory seam (design 4.2, plan Task 12 step 2). Every
 * slot/worktree invocation builds a FRESH adapter bound to that worktree and
 * to the run-specific evidence directory the pool hands in — the factory never
 * caches or reuses an adapter instance, so no provider hidden history or
 * mutable adapter state can cross Task boundaries. The provider selection and
 * manifest validation stay exactly the sequential executor's (dsh today): the
 * manifest is read once from a probe instance that never runs a Task.
 */
export function createProjectAgentSlotFactory(context: ProjectAgentContext): AgentSlotFactory {
  const build = (worktree: string, evidenceDir: string) =>
    createDshAgentAdapter({
      executable: context.config.executable,
      launcher_args: context.config.launcher_args,
      expected_version: context.config.expected_version,
      worktree,
      evidence_dir: evidenceDir,
      inspector: context.inspector ?? createGitRepositoryInspector(),
      env_allowlist: context.config.env_allowlist,
      ...(context.spawnProcess === undefined ? {} : { spawnProcess: context.spawnProcess }),
    });
  // The probe instance only exposes the manifest; it never executes a Task.
  const probe = build(
    context.projectRoot,
    join(context.projectRoot, ".harness", "raw-traces", "agent-dsh"),
  );
  return {
    adapter_manifest_digest: contentDigest({ adapter_manifest: probe.manifest }),
    manifest: probe.manifest,
    create: ({ worktree_root, evidence_dir }) => build(worktree_root, evidence_dir),
  };
}

/**
 * The pre-run supervision notice (design 10.1/21): a manual adapter — or a
 * delegated adapter that fails unattended eligibility — is forced into
 * supervised single-slot execution, and the operator must see that before any
 * run starts. Returns undefined when the manifest may run unattended.
 */
export function supervisedSingleSlotNotice(manifest: AgentProviderManifest): string | undefined {
  const assessment = assessUnattendedEligibility(manifest);
  if (assessment.eligible) return undefined;
  return (
    `并行调度降级为监督单槽位模式（supervised single-slot）：${assessment.reasons.join("；")}。` +
    "每次只运行一个 Task，且进程处于监督模式。"
  );
}
