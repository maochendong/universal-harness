import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { createRuntimeService, type BootstrapError } from "@universal-harness-internal/runtime";

import { EXIT_CODES, asCliError, usageError } from "./errors.js";
import {
  exitCodeForStatus,
  renderError,
  renderHuman,
  renderJson,
  type CliIo,
  type CommandResult,
} from "./io.js";
import { runAdoptCommand } from "./commands/adopt.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runIterateCommand } from "./commands/iterate.js";
import { runNewCommand } from "./commands/new.js";
import { runResumeCommand } from "./commands/resume.js";
import { runStatusCommand } from "./commands/status.js";
import { runGraphCheckCommand } from "./commands/graph/check.js";
import { runGraphQueryCommand } from "./commands/graph/query.js";
import { runGraphSyncCommand } from "./commands/graph/sync.js";

export const CLI_VERSION = "0.0.0" as const;

/**
 * Typed port between the CLI shell and the runtime orchestration services
 * (design section 11.1). Command handlers only parse arguments and delegate;
 * no business logic lives in the CLI package.
 */
export interface NewProjectRequest {
  readonly name: string;
  readonly intent: string;
}

export interface AdoptProjectRequest {
  readonly path: string;
  readonly intent: string;
}

export interface IterateRequest {
  readonly text: string;
  readonly projectRoot: string;
}

export interface ResumeRequest {
  readonly workflowOperationId: string;
  readonly projectRoot: string;
}

export interface RuntimeService {
  newProject(request: NewProjectRequest): Promise<CommandResult>;
  adoptProject(request: AdoptProjectRequest): Promise<CommandResult>;
  iterate(request: IterateRequest): Promise<CommandResult>;
  resume(request: ResumeRequest): Promise<CommandResult>;
}

function stageUnavailable(
  command: string,
  stage: string,
  request: Record<string, unknown>,
): CommandResult {
  return {
    command,
    status: "stage_unavailable",
    message: `orchestration stage ${stage} is not implemented yet; no project state was changed`,
    data: { stage, request },
  };
}

/**
 * Stub runtime service for orchestration stages that have not landed yet
 * (iterate/resume). It answers with an explicit stage status instead of
 * faking success, so scripts can rely on the exit code today.
 */
export function createStubRuntimeService(): RuntimeService {
  return {
    newProject: (request) =>
      Promise.resolve(stageUnavailable("new", "bootstrap.new_project", { ...request })),
    adoptProject: (request) =>
      Promise.resolve(stageUnavailable("adopt", "bootstrap.adopt_project", { ...request })),
    iterate: (request) =>
      Promise.resolve(stageUnavailable("iterate", "orchestration.iterate", { ...request })),
    resume: (request) =>
      Promise.resolve(stageUnavailable("resume", "orchestration.resume", { ...request })),
  };
}

function bootstrapFailure(command: string, error: BootstrapError): CommandResult {
  return {
    command,
    status: "failed",
    message: error.message,
    data: { kind: error.kind, ...(error.data ?? {}) },
  };
}

/**
 * Default runtime wiring: `new` and `adopt` delegate to the runtime bootstrap
 * service over the Git VCS adapter, while iterate/resume keep reporting their
 * explicit stage status. The adopt route stops at the staged preview: the
 * approval interaction (Task 11) is not implemented yet, so no authoritative
 * state changes and the stage status says exactly that.
 */
export function createDefaultRuntimeService(cwd: string): RuntimeService {
  const runtime = createRuntimeService({ vcs: createGitVcsAdapter() });
  const stub = createStubRuntimeService();
  return {
    newProject: async (request) => {
      const outcome = await runtime.newProject({
        parentDirectory: cwd,
        name: request.name,
        intent: request.intent,
      });
      if (!outcome.ok) return bootstrapFailure("new", outcome.error);
      const value = outcome.value;
      return {
        command: "new",
        status: "ok",
        message: `created project ${value.name} with bootstrap baseline ${value.ledgerOperationId}`,
        data: { ...value },
      };
    },
    adoptProject: async (request) => {
      const outcome = await runtime.prepareAdoption({
        projectRoot: resolve(cwd, request.path),
        intent: request.intent,
      });
      if (!outcome.ok) return bootstrapFailure("adopt", outcome.error);
      const value = outcome.value;
      return {
        command: "adopt",
        status: "stage_unavailable",
        message:
          `adoption preview staged under .harness/staging/${value.stagingOperationId}; ` +
          "baseline approval is not implemented yet; no authoritative state was changed",
        data: {
          stage: "approval.interaction",
          staging_operation_id: value.stagingOperationId,
          preview_digest: value.previewDigest,
          baseline_commit: value.baselineCommit,
          workflow_operation_id: value.workflowOperationId,
          stack: value.preview.stack.primary,
          files: value.preview.files.length,
          components: value.preview.components.length,
          conflicts: value.preview.conflicts,
          unknown_items: value.preview.unknown_items,
        },
      };
    },
    iterate: stub.iterate,
    resume: stub.resume,
  };
}

export interface CommandContext {
  readonly io: CliIo;
  readonly cwd: string;
  readonly json: boolean;
  readonly runtime: RuntimeService;
  /** Probe for the git executable; injectable so tests stay hermetic. */
  readonly gitVersion: () => string | undefined;
}

export interface CliDependencies {
  readonly io: CliIo;
  readonly cwd: string;
  readonly runtime?: RuntimeService;
  readonly gitVersion?: () => string | undefined;
}

function defaultGitVersion(): string | undefined {
  try {
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

const GLOBAL_HELP = `Universal Harness - graph-native, Git-native engineering harness.

Usage: harness <command> [options]

Orchestration:
  new <name> --intent <text>      Create a managed project and run the first iteration
  adopt [path] --intent <text>    Adopt an existing project and run an iteration
  iterate <text>                  Run a full iteration for a follow-up change
  resume <workflow-operation-id>  Resume a paused orchestration from its checkpoint

Inspection:
  status                          Show project state, cache health and next action
  doctor                          Diagnose environment, Git, layout and cache issues
  graph sync                      Rebuild the SQLite graph cache from the ledger
  graph query [--type <type>]     Query materialized graph nodes
  graph check                     Verify ledger integrity and cache consistency

Global options:
  --json                          Emit one canonical JSON record (machine readable)
  --help, -h                      Show help
  --version                       Show the CLI version
`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  new: `Usage: harness new <name> --intent <text> [--json]

Create a managed project directory, initialize the .harness control plane
(manifest, pack lock, ledger, managed .gitignore/.gitattributes) and run the
first full iteration for the given intent.
`,
  adopt: `Usage: harness adopt [path] --intent <text> [--json]

Adopt an existing project: scan it into staging, approve the deterministic
baseline, then run the requested iteration. Nothing outside .harness is
modified, and the project root .gitignore is never touched.
`,
  iterate: `Usage: harness iterate <text> [--json]

Run the full closed loop (capture, plan, execute, verify, evaluate, repair,
snapshot) for a follow-up change inside the current managed project.
`,
  resume: `Usage: harness resume <workflow-operation-id> [--json]

Resume a paused orchestration from its last committed checkpoint. The
workflow operation id is returned by earlier blocked or deferred runs.
`,
  status: `Usage: harness status [--json]

Show the managed project identity, committed ledger operation count, graph
cache health and the last ledger operation for the current project.
`,
  doctor: `Usage: harness doctor [--json]

Diagnose the runtime environment, Git availability, managed project layout
and graph cache health. Exits non-zero when any check fails.
`,
  graph: `Usage: harness graph <sync|query|check> [options]

  sync    Rebuild the disposable SQLite cache from the authoritative ledger
  query   Query materialized graph nodes (--type, --limit, --cursor)
  check   Verify ledger integrity invariants and cache consistency
`,
};

function helpFor(command: string | undefined): string {
  if (command !== undefined) {
    const help = COMMAND_HELP[command];
    if (help !== undefined) return help;
  }
  return GLOBAL_HELP;
}

interface GlobalFlags {
  readonly json: boolean;
  readonly help: boolean;
  readonly args: string[];
}

/**
 * Extract global flags before dispatching. Only exact `--json`, `--help` and
 * `-h` tokens are consumed here; everything else reaches the per-command
 * strict parser untouched.
 */
function extractGlobalFlags(argv: readonly string[]): GlobalFlags {
  const args: string[] = [];
  let json = false;
  let help = false;
  for (const token of argv) {
    if (token === "--json") {
      json = true;
    } else if (token === "--help" || token === "-h") {
      help = true;
    } else {
      args.push(token);
    }
  }
  return { json, help, args };
}

async function dispatch(args: readonly string[], context: CommandContext): Promise<CommandResult> {
  const [command, ...rest] = args;
  switch (command) {
    case "new":
      return runNewCommand(rest, context);
    case "adopt":
      return runAdoptCommand(rest, context);
    case "iterate":
      return runIterateCommand(rest, context);
    case "resume":
      return runResumeCommand(rest, context);
    case "status":
      return runStatusCommand(rest, context);
    case "doctor":
      return runDoctorCommand(rest, context);
    case "graph": {
      const [subcommand, ...subRest] = rest;
      switch (subcommand) {
        case "sync":
          return runGraphSyncCommand(subRest, context);
        case "query":
          return runGraphQueryCommand(subRest, context);
        case "check":
          return runGraphCheckCommand(subRest, context);
        default:
          throw usageError(
            `unknown graph subcommand: ${subcommand ?? "none"}; expected sync, query or check`,
          );
      }
    }
    default:
      throw usageError(`unknown command: ${command ?? "none"}; run harness --help`);
  }
}

/**
 * Entry point for the `harness` binary and for programmatic embedding.
 * Returns the process exit code instead of exiting, so tests and hosts keep
 * control of the process lifecycle.
 */
export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const { io } = dependencies;
  const flags = extractGlobalFlags(argv);
  if (flags.args[0] === "--version") {
    io.writeStdout(`universal-harness ${CLI_VERSION}\n`);
    return EXIT_CODES.ok;
  }
  if (flags.help || flags.args.length === 0) {
    io.writeStdout(helpFor(flags.args[0]));
    return EXIT_CODES.ok;
  }
  const context: CommandContext = {
    io,
    cwd: dependencies.cwd,
    json: flags.json,
    runtime: dependencies.runtime ?? createDefaultRuntimeService(dependencies.cwd),
    gitVersion: dependencies.gitVersion ?? defaultGitVersion,
  };
  try {
    const result = await dispatch(flags.args, context);
    io.writeStdout(flags.json ? renderJson(result) : renderHuman(result));
    return exitCodeForStatus(result.status);
  } catch (error) {
    const cliError = asCliError(error);
    io.writeStderr(renderError(cliError, flags.json));
    return cliError.exitCode;
  }
}
