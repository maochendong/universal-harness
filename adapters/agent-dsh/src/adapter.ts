import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { contentDigest } from "@universal-harness-internal/core";
import {
  assessUnattendedEligibility,
  buildScrubbedEnvironment,
  observeAgentBudget,
  type AgentAdapter,
  type AgentEvidenceLocator,
  type AgentRunResult,
  type AgentTaskEnvelope,
} from "@universal-harness-internal/plugin-sdk";
import {
  ProcessSpawnError,
  runCommandProcess,
  undeclaredWrites,
  type ProcessRunOptions,
  type ProcessRunResult,
  type RepositoryInspector,
} from "@universal-harness-internal/adapter-agent-command";

import { renderDshTask } from "./prompt.js";

export type DshProcessRunner = (
  executable: string,
  options: ProcessRunOptions,
) => Promise<ProcessRunResult>;

export interface DshAgentAdapterOptions {
  readonly executable?: string;
  readonly launcher_args?: readonly string[];
  readonly expected_version: string;
  readonly worktree: string;
  readonly evidence_dir: string;
  readonly inspector: RepositoryInspector;
  readonly env_allowlist?: readonly string[];
  readonly timeout_ms?: number;
  readonly max_output_bytes?: number;
  readonly spawnProcess?: DshProcessRunner;
}

const DEFAULT_ENV_ALLOWLIST = [
  "DEEPSEEK_API_KEY",
  "DSH_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
] as const;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function emptyFailure(
  outcome: AgentRunResult["outcome"],
  terminationReason: AgentRunResult["termination_reason"],
  summary: string,
): AgentRunResult {
  return {
    outcome,
    termination_reason: terminationReason,
    completion_claimed: false,
    summary,
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
    evidence: [],
    undeclared_writes: [],
  };
}

function withDuration(result: AgentRunResult, durationMs: number): AgentRunResult {
  return { ...result, usage: { ...result.usage, duration_ms: durationMs } };
}

function withBudgetObservations(
  envelope: AgentTaskEnvelope,
  profile: AgentAdapter["manifest"],
  result: AgentRunResult,
): AgentRunResult {
  return {
    ...result,
    budget_observations: observeAgentBudget({
      budget: envelope.loop_policy,
      usage: result.usage,
      profile,
    }),
  };
}

/** Create the supervised dsh headless adapter described by the public AgentAdapter port. */
export function createDshAgentAdapter(options: DshAgentAdapterOptions): AgentAdapter {
  const executable = options.executable ?? "npx";
  const launcherArgs = [
    ...(options.launcher_args ?? ["--no-install", "@deepseek-ai/dsh"]),
  ] as const;
  const worktree = resolve(options.worktree);
  const evidenceDir = resolve(options.evidence_dir);
  const spawnProcess = options.spawnProcess ?? runCommandProcess;
  const maxOutputBytes = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const environment = buildScrubbedEnvironment(
    options.env_allowlist ?? DEFAULT_ENV_ALLOWLIST,
    process.env,
  );
  const manifest = {
    provider: "dsh",
    control: "delegated",
    trajectory_visibility: "external-only",
    usage_metering: false,
    side_effect_interception: false,
    resume_semantics: "none",
  } as const;
  let probePassed = false;

  const runProcess = (
    args: readonly string[],
    timeoutMs: number,
    onOutput?: NonNullable<Parameters<AgentAdapter["run"]>[1]["on_output"]>,
  ): Promise<ProcessRunResult> =>
    spawnProcess(executable, {
      args,
      cwd: worktree,
      env: environment,
      timeout_ms: timeoutMs,
      max_output_bytes: maxOutputBytes,
      ...(onOutput === undefined ? {} : { on_output: onOutput }),
    });

  return {
    name: "agent-dsh",
    manifest,

    async run(envelope: AgentTaskEnvelope, runOptions): Promise<AgentRunResult> {
      if (runOptions.mode === "unattended") {
        const assessment = assessUnattendedEligibility(manifest);
        return withBudgetObservations(
          envelope,
          manifest,
          emptyFailure(
            "correct_block",
            "policy_denial",
            `unattended dsh run refused: ${assessment.reasons.join("; ")}`,
          ),
        );
      }

      const timeoutMs = Math.min(
        options.timeout_ms ?? envelope.loop_policy.max_duration_ms,
        envelope.loop_policy.max_duration_ms,
      );
      try {
        if (!probePassed) {
          const probe = await runProcess(
            [...launcherArgs, "--version"],
            Math.min(timeoutMs, 30000),
          );
          if (probe.exit_code !== 0 || probe.stdout.trim() !== options.expected_version) {
            return withBudgetObservations(
              envelope,
              manifest,
              withDuration(
                emptyFailure(
                  "failed",
                  "adapter_failure",
                  `dsh contract probe failed: expected ${options.expected_version}, got ` +
                    `${probe.stdout.trim() || probe.stderr.trim() || String(probe.exit_code)}`,
                ),
                probe.duration_ms,
              ),
            );
          }
          probePassed = true;
        }

        const before = await options.inspector.inspect(worktree);
        const processResult = await runProcess(
          [...launcherArgs, "--profile", "headless", renderDshTask(envelope)],
          timeoutMs,
          runOptions.on_output,
        );
        const after = await options.inspector.inspect(worktree);
        const newlyChanged = after.changed_paths
          .filter((path) => !new Set(before.changed_paths).has(path))
          .sort();
        const outsideScope = undeclaredWrites(before, after, envelope.proposed_write_paths);
        const transcript = {
          task_id: envelope.task_id,
          envelope_digest: envelope.digest,
          provider: "dsh",
          provider_version: options.expected_version,
          exit_code: processResult.exit_code,
          signal: processResult.signal,
          timed_out: processResult.timed_out,
          output_truncated: processResult.output_truncated,
          duration_ms: processResult.duration_ms,
          stdout: processResult.stdout,
          stderr: processResult.stderr,
        };
        mkdirSync(evidenceDir, { recursive: true });
        const transcriptPath = join(evidenceDir, `transcript-${envelope.task_id}.json`);
        writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2), "utf8");
        const evidence: AgentEvidenceLocator[] = [
          { kind: "transcript", locator: transcriptPath, digest: contentDigest(transcript) },
          {
            kind: "diff",
            locator: `repository://${envelope.repository_id}`,
            digest: contentDigest({ before: before.digest, after: after.digest }),
          },
        ];
        const base = {
          usage: {
            input_tokens: null,
            output_tokens: null,
            total_tokens: null,
            duration_ms: processResult.duration_ms,
            metering: "unmetered" as const,
          },
          evidence,
        };

        if (processResult.timed_out) {
          return withBudgetObservations(envelope, manifest, {
            ...emptyFailure(
              "partial",
              "timeout",
              `dsh exceeded the Harness-enforced duration ceiling of ${String(timeoutMs)} ms`,
            ),
            ...base,
          });
        }
        if (processResult.output_truncated) {
          return withBudgetObservations(envelope, manifest, {
            ...emptyFailure(
              "failed",
              "adapter_failure",
              `dsh exceeded the output cap of ${String(maxOutputBytes)} bytes`,
            ),
            ...base,
          });
        }
        if (processResult.exit_code !== 0) {
          return withBudgetObservations(envelope, manifest, {
            ...emptyFailure(
              "failed",
              "adapter_failure",
              `dsh exited with code ${String(processResult.exit_code)}: ${processResult.stderr.trim().slice(0, 500)}`,
            ),
            ...base,
          });
        }
        if (outsideScope.length > 0) {
          return withBudgetObservations(envelope, manifest, {
            ...emptyFailure(
              "failed",
              "adapter_failure",
              `dsh changed undeclared paths: ${outsideScope.join(", ")}`,
            ),
            ...base,
            undeclared_writes: outsideScope,
          });
        }
        const summary = processResult.stdout.trim();
        if (summary.length === 0) {
          return withBudgetObservations(envelope, manifest, {
            ...emptyFailure("failed", "adapter_failure", "dsh returned empty stdout"),
            ...base,
          });
        }
        return withBudgetObservations(envelope, manifest, {
          outcome: "handoff",
          termination_reason: "completion",
          completion_claimed: true,
          summary,
          state_proposal: null,
          dropped_proposal_fields: [],
          change_summary: {
            files_changed: newlyChanged.length,
            insertions: 0,
            deletions: 0,
            paths: newlyChanged,
          },
          tool_activity: { total_calls: 0, governed_calls: 0, by_tool: {} },
          ...base,
          undeclared_writes: [],
        });
      } catch (error) {
        if (error instanceof ProcessSpawnError) {
          return withBudgetObservations(
            envelope,
            manifest,
            emptyFailure(
              "failed",
              "adapter_failure",
              `dsh process could not start: ${error.message}`,
            ),
          );
        }
        throw error;
      }
    },
  };
}
