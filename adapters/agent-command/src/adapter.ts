import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { contentDigest } from "@universal-harness-internal/core";
import {
  AgentError,
  assessUnattendedEligibility,
  filterStateProposal,
  isWithinDeclaredPath,
  type AgentAdapter,
  type AgentEvidenceLocator,
  type AgentRunResult,
  type AgentTaskEnvelope,
} from "@universal-harness-internal/plugin-sdk";

import {
  buildEnvironment,
  renderArgs,
  validateCommandManifest,
  type CommandProviderManifest,
} from "./manifest.js";
import { runCommandProcess, ProcessSpawnError } from "./process.js";
import { parseProviderResult, type ProviderResult } from "./telemetry.js";

/**
 * Generic Command AgentAdapter (design 13.2, control level `delegated`). The
 * Harness governs the outer provider command -- fixed executable, argument
 * template, confined worktree, scrubbed environment, timeout, output cap,
 * structured result parsing and pre/post repository inspection -- while the
 * provider owns its internal loop. Repository inspection supplies evidence;
 * it is not a containment boundary, and the provider's internal tools are
 * never reported as Harness-governed.
 *
 * Every run writes one transcript artifact into the evidence directory so an
 * external-only provider still leaves a Harness-side trajectory record.
 */

/** Snapshot of the repository around a delegated run. */
export interface RepositoryInspection {
  readonly head: string | null;
  /** Repository-relative paths differing from HEAD at inspection time. */
  readonly changed_paths: readonly string[];
  /** Content digest of the snapshot. */
  readonly digest: string;
}

export interface RepositoryInspector {
  inspect(root: string): Promise<RepositoryInspection>;
}

export interface CommandAgentAdapterOptions {
  readonly manifest: CommandProviderManifest;
  /** Confined working directory the provider process runs in. */
  readonly worktree: string;
  /** Directory the adapter writes transcript evidence into. */
  readonly evidence_dir: string;
  /** Pre/post repository inspection; undeclared writes fail the run. */
  readonly inspector?: RepositoryInspector;
  /** Run timeout; clamped to the envelope's duration ceiling. */
  readonly timeout_ms?: number;
  /** Combined stdout+stderr capture cap; default 1 MiB. */
  readonly max_output_bytes?: number;
  /** Injectable for tests; defaults to the real spawn-based runner. */
  readonly spawnProcess?: typeof runCommandProcess;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function failureResult(
  outcome: AgentRunResult["outcome"],
  termination: AgentRunResult["termination_reason"],
  summary: string,
): AgentRunResult {
  return {
    outcome,
    termination_reason: termination,
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

/** Paths the run touched that the envelope did not declare as write paths. */
export function undeclaredWrites(
  before: RepositoryInspection,
  after: RepositoryInspection,
  proposedWritePaths: readonly string[],
): string[] {
  const prior = new Set(before.changed_paths);
  return after.changed_paths
    .filter((path) => !prior.has(path))
    .filter((path) => !proposedWritePaths.some((declared) => isWithinDeclaredPath(declared, path)))
    .sort();
}

/**
 * Create a command adapter for one provider manifest. The manifest is
 * validated at construction; a structurally invalid one throws a typed
 * `invalid_manifest` AgentError.
 */
export function createCommandAgentAdapter(options: CommandAgentAdapterOptions): AgentAdapter {
  const manifest = validateCommandManifest(options.manifest);
  const worktree = resolve(options.worktree);
  const spawnProcess = options.spawnProcess ?? runCommandProcess;
  const maxOutputBytes = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    name: "agent-command",
    manifest,

    async run(envelope: AgentTaskEnvelope, runOptions): Promise<AgentRunResult> {
      if (runOptions.mode === "unattended") {
        const assessment = assessUnattendedEligibility(manifest);
        if (!assessment.eligible) {
          return failureResult(
            "correct_block",
            "policy_denial",
            `unattended delegated run refused: ${assessment.reasons.join("; ")}`,
          );
        }
      }

      const evidenceDir = resolve(options.evidence_dir);
      mkdirSync(evidenceDir, { recursive: true });
      const inputDir = mkdtempSync(join(tmpdir(), "harness-agent-input-"));
      const inputFile = join(inputDir, "envelope.json");
      writeFileSync(
        inputFile,
        JSON.stringify(
          {
            envelope,
            mode: runOptions.mode,
            resume: runOptions.resume ?? null,
          },
          null,
          2,
        ),
      );

      const before = options.inspector ? await options.inspector.inspect(worktree) : undefined;
      const timeoutMs = Math.min(
        options.timeout_ms ?? envelope.loop_policy.max_duration_ms,
        envelope.loop_policy.max_duration_ms,
      );

      let processResult;
      try {
        processResult = await spawnProcess(manifest.executable, {
          args: renderArgs(manifest, inputFile),
          cwd: worktree,
          env: buildEnvironment(manifest, process.env),
          timeout_ms: timeoutMs,
          max_output_bytes: maxOutputBytes,
        });
      } catch (error) {
        if (error instanceof ProcessSpawnError) {
          return failureResult(
            "failed",
            "adapter_failure",
            `provider process could not start: ${error.message}`,
          );
        }
        throw error;
      }

      const transcript = {
        task_id: envelope.task_id,
        envelope_digest: envelope.digest,
        provider: manifest.provider,
        executable: manifest.executable,
        exit_code: processResult.exit_code,
        signal: processResult.signal,
        timed_out: processResult.timed_out,
        output_truncated: processResult.output_truncated,
        duration_ms: processResult.duration_ms,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
      };
      const transcriptPath = join(evidenceDir, `transcript-${envelope.task_id}.json`);
      writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
      const transcriptEvidence: AgentEvidenceLocator = {
        kind: "transcript",
        locator: transcriptPath,
        digest: contentDigest(transcript),
      };

      const usageBase = {
        duration_ms: processResult.duration_ms,
      };
      const withTranscript = (
        result: AgentRunResult,
        extraEvidence: readonly AgentEvidenceLocator[] = [],
      ): AgentRunResult => ({
        ...result,
        usage: { ...result.usage, ...usageBase },
        evidence: [transcriptEvidence, ...extraEvidence],
      });

      if (processResult.timed_out) {
        return withTranscript(
          failureResult(
            "partial",
            "timeout",
            `provider exceeded the Harness-enforced duration ceiling of ${String(timeoutMs)} ms`,
          ),
        );
      }
      if (processResult.output_truncated) {
        return withTranscript(
          failureResult(
            "failed",
            "adapter_failure",
            `provider exceeded the output cap of ${String(maxOutputBytes)} bytes`,
          ),
        );
      }
      if (processResult.exit_code !== 0) {
        return withTranscript(
          failureResult(
            "failed",
            "adapter_failure",
            `provider exited with code ${String(processResult.exit_code)}: ` +
              processResult.stderr.trim().slice(0, 500),
          ),
        );
      }

      let providerResult: ProviderResult;
      try {
        providerResult = parseProviderResult(processResult.stdout);
      } catch (error) {
        if (error instanceof AgentError && error.kind === "invalid_result") {
          return withTranscript(
            failureResult(
              "failed",
              "adapter_failure",
              `provider result rejected: ${error.message}`,
            ),
          );
        }
        throw error;
      }

      // An automatic adapter must report usage for a completion claim when
      // its manifest claims metering; a missing report is an adapter
      // failure, never a free pass.
      const usageReport = providerResult.usage;
      if (
        providerResult.status === "completed" &&
        manifest.usage_metering &&
        usageReport?.total_tokens == null
      ) {
        return withTranscript(
          failureResult(
            "failed",
            "adapter_failure",
            "manifest declares usage metering but the provider reported no token usage",
          ),
        );
      }
      const usage = {
        input_tokens: usageReport?.input_tokens ?? null,
        output_tokens: usageReport?.output_tokens ?? null,
        total_tokens: usageReport?.total_tokens ?? null,
        duration_ms: processResult.duration_ms,
        metering: (manifest.usage_metering ? "provider_reported" : "unmetered") as
          "provider_reported" | "unmetered",
      };

      if (usage.total_tokens !== null && usage.total_tokens > envelope.loop_policy.max_tokens) {
        return withTranscript({
          ...failureResult(
            "partial",
            "budget_ceiling",
            `provider reported ${String(usage.total_tokens)} tokens against the envelope ` +
              `ceiling of ${String(envelope.loop_policy.max_tokens)}`,
          ),
          usage,
        });
      }

      const providerEvidence = providerResult.evidence ?? [];

      // Post-run repository inspection: evidence, plus undeclared-write
      // detection. A provider claiming completion while writing outside the
      // envelope fails the run; the claim is never trusted over the diff.
      if (options.inspector !== undefined && before !== undefined) {
        const after = await options.inspector.inspect(worktree);
        const undeclared = undeclaredWrites(before, after, envelope.proposed_write_paths);
        const inspectionEvidence: AgentEvidenceLocator = {
          kind: "diff",
          locator: `repository://${envelope.repository_id}`,
          digest: contentDigest({ before: before.digest, after: after.digest }),
        };
        if (undeclared.length > 0) {
          return withTranscript(
            {
              ...failureResult(
                "failed",
                "adapter_failure",
                `provider changed undeclared paths: ${undeclared.join(", ")}`,
              ),
              usage,
              undeclared_writes: undeclared,
            },
            [inspectionEvidence, ...providerEvidence],
          );
        }
        const changedPaths = after.changed_paths.filter(
          (path) => !new Set(before.changed_paths).has(path),
        );
        return withTranscript(finishRun(envelope, providerResult, usage, changedPaths), [
          inspectionEvidence,
          ...providerEvidence,
        ]);
      }

      return withTranscript(finishRun(envelope, providerResult, usage, []), providerEvidence);
    },
  };
}

function finishRun(
  envelope: AgentTaskEnvelope,
  providerResult: ProviderResult,
  usage: AgentRunResult["usage"],
  changedPaths: readonly string[],
): AgentRunResult {
  const filtered = filterStateProposal(
    providerResult.state_proposal ?? {},
    envelope.state_proposal_fields,
  );
  const toolActivity = providerResult.tool_activity;
  return {
    outcome: providerResult.status === "completed" ? "handoff" : "failed",
    termination_reason: providerResult.status === "completed" ? "completion" : "adapter_failure",
    // A completion claim, never a self-minted success: the Harness verifies.
    completion_claimed: providerResult.status === "completed",
    summary:
      providerResult.status === "completed"
        ? providerResult.summary
        : `${providerResult.summary}${providerResult.message ? `: ${providerResult.message}` : ""}`,
    state_proposal: Object.keys(filtered.proposal).length > 0 ? filtered.proposal : null,
    dropped_proposal_fields: filtered.dropped,
    change_summary: {
      files_changed: changedPaths.length,
      insertions: 0,
      deletions: 0,
      paths: changedPaths,
    },
    tool_activity: {
      total_calls: toolActivity?.total_calls ?? 0,
      // The internal tools of an opaque provider are never Harness-governed.
      governed_calls: 0,
      by_tool: toolActivity?.by_tool ?? {},
    },
    usage,
    evidence: [],
    undeclared_writes: [],
  };
}
