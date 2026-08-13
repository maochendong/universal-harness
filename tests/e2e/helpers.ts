import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOrchestratedRuntimeService,
  runCli,
  type CliIo,
  type RuntimeService,
} from "../../packages/cli/src/index.js";
import type { AgentRunResult, AgentTaskEnvelope } from "../../packages/plugin-sdk/src/index.js";
import type { GateDefinition, ToolRegistry } from "../../packages/runtime/src/index.js";

/**
 * Shared E2E plumbing (plan Task 23): real CLI entry point over real Git
 * repositories, with the deterministic ports (fixed clock, sequential ids,
 * recording fake executor) injected through the public service factory.
 */
export const FIXED_NOW = "2026-08-12T00:00:00.000Z";

const createdRoots: string[] = [];

export function cleanupE2eRoots(): void {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
}

export function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  createdRoots.push(directory);
  return directory;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export interface Captured {
  readonly io: CliIo;
  stdout(): string;
  stderr(): string;
}

export function captureIo(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeStdout: (text) => out.push(text),
      writeStderr: (text) => err.push(text),
      isInteractive: false,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

export interface E2eHarness {
  readonly runtime: RuntimeService;
  readonly executorCalls: readonly AgentTaskEnvelope[];
}

/** Deterministic fake executor: claims completion, records every envelope. */
export function makeExecutor(): {
  readonly calls: AgentTaskEnvelope[];
  readonly executor: (envelope: AgentTaskEnvelope) => Promise<AgentRunResult>;
} {
  const calls: AgentTaskEnvelope[] = [];
  return {
    calls,
    executor: (envelope) => {
      calls.push(envelope);
      const result: AgentRunResult = {
        outcome: "handoff",
        termination_reason: "completion",
        completion_claimed: true,
        summary: `fake executor completed ${envelope.task_id} (call ${String(calls.length)})`,
        state_proposal: null,
        dropped_proposal_fields: [],
        change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
        tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
        usage: {
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          duration_ms: 0,
          metering: "unmetered",
        },
        evidence: [
          {
            kind: "attestation",
            locator: `envelope://${envelope.task_id}`,
            digest: envelope.digest.padEnd(64, "0").slice(0, 64),
          },
        ],
        undeclared_writes: [],
      };
      return Promise.resolve(result);
    },
  };
}

export function makeHarness(
  cwd: string,
  newId: (kind: string) => string,
  injection?: {
    readonly gates?: readonly GateDefinition[];
    readonly toolRegistry?: ToolRegistry;
  },
): E2eHarness {
  const executor = makeExecutor();
  const runtime = createOrchestratedRuntimeService({
    cwd,
    io: captureIo().io,
    now: () => FIXED_NOW,
    newId,
    execute: executor.executor,
    ...(injection?.gates === undefined ? {} : { gates: injection.gates }),
    ...(injection?.toolRegistry === undefined ? {} : { toolRegistry: injection.toolRegistry }),
  });
  return { runtime, executorCalls: executor.calls };
}

export function sequentialIds(): (kind: string) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_t${String(next).padStart(4, "0")}`;
  };
}

export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, unknown>;
}

export async function runJson(
  argv: readonly string[],
  options: { readonly cwd: string; readonly runtime: RuntimeService },
): Promise<CliRun> {
  const captured = captureIo();
  const exitCode = await runCli([...argv, "--json"], {
    io: captured.io,
    cwd: options.cwd,
    runtime: options.runtime,
  });
  return {
    exitCode,
    stdout: captured.stdout(),
    stderr: captured.stderr(),
    json: JSON.parse(captured.stdout()) as Record<string, unknown>,
  };
}

/** Approve the pending request an approval_required result reports, then resume. */
export async function approveAndResume(
  result: CliRun,
  options: { readonly cwd: string; readonly runtime: RuntimeService },
): Promise<CliRun> {
  const data = result.json["data"] as Record<string, unknown>;
  const requestId = data["request_id"] as string;
  const workflowOperationId = data["workflow_operation_id"] as string;
  const approved = await runJson(
    ["approve", requestId, "--decision", "approve", "--actor", "human:e2e"],
    options,
  );
  if (approved.exitCode !== 0) {
    throw new Error(`approve failed: ${approved.stdout} ${approved.stderr}`);
  }
  return runJson(["resume", workflowOperationId], options);
}
