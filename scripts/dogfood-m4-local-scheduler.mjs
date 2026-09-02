#!/usr/bin/env node
/**
 * Real-Agent M4 dogfood probe. The production dsh Adapter is currently
 * delegated/external-only, so this script proves one supervised isolated Git
 * Task and records the fail-closed concurrency prerequisite. It never
 * promotes dsh to managed or calls a single-slot run "parallel".
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redactM4Evidence } from "./dogfood-m4-redaction.mjs";
import {
  captureDshSessionBoundary,
  captureWorkspaceProofBoundary,
  collectPackageBuildProvenance,
  readDshInvocationEvidence,
  resolveDshExecutable,
  resolveDshSessionRoot,
  resolveExpectedDshVersion,
  verifyProbeWorkspace,
} from "./m4-dogfood-proof.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliArgs = process.argv.slice(2);
const argValue = (name) => {
  const index = cliArgs.indexOf(name);
  return index === -1 ? undefined : cliArgs[index + 1];
};

function loadDotEnv(path) {
  const loaded = new Set();
  if (!existsSync(path)) return loaded;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match === null || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
    loaded.add(match[1]);
  }
  return loaded;
}

const loadedEnvNames = loadDotEnv(resolve(argValue("--env-file") ?? join(repositoryRoot, ".env")));

const dshExecutable = resolveDshExecutable({
  argument: argValue("--dsh"),
  environment: process.env.HARNESS_DSH_EXECUTABLE,
});
const expectedProviderVersion = resolveExpectedDshVersion({
  argument: argValue("--expected-dsh-version"),
});
const dshSessionRoot = resolveDshSessionRoot({
  dshHome: process.env.DSH_HOME,
  home: process.env.HOME,
});
const outputPath = resolve(
  argValue("--out") ?? join(repositoryRoot, ".reports", "acceptance", "m4-dogfood.json"),
);
const implementationCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const trackedStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const secretValues = [process.env.DEEPSEEK_API_KEY];
const absolutePaths = [repositoryRoot, process.env.HOME, dshExecutable];

function writeBundle(bundle) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    redactM4Evidence(`${JSON.stringify(bundle, null, 2)}\n`, {
      secrets: secretValues,
      absolute_paths: absolutePaths,
    }),
    "utf8",
  );
  console.log(`M4 dogfood Evidence: ${outputPath}`);
}

function blocked(reason, evidence = {}) {
  writeBundle({
    schema_version: 1,
    milestone: "M4",
    status: "blocked",
    blocker: reason,
    implementation_commit: implementationCommit,
    generated_at: new Date().toISOString(),
    ...evidence,
  });
  process.exitCode = 2;
}

function createCleanBuildRoot(commit) {
  const buildRoot = realpathSync(mkdtempSync(join(tmpdir(), "harness-m4-build-")));
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", commit], {
      cwd: repositoryRoot,
      maxBuffer: 100 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", buildRoot], { input: archive });
    execFileSync("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: buildRoot,
      stdio: "pipe",
      maxBuffer: 100 * 1024 * 1024,
    });
    execFileSync("pnpm", ["build"], {
      cwd: buildRoot,
      stdio: "pipe",
      maxBuffer: 100 * 1024 * 1024,
    });
    return buildRoot;
  } catch (error) {
    rmSync(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

if (trackedStatus !== "") {
  blocked("tracked_repository_not_clean", {
    command: "git status --porcelain --untracked-files=no",
  });
} else if (!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_MODEL) {
  blocked("provider_configuration_missing", {
    missing: [
      ...(!process.env.DEEPSEEK_API_KEY ? ["DEEPSEEK_API_KEY"] : []),
      ...(!process.env.DEEPSEEK_MODEL ? ["DEEPSEEK_MODEL"] : []),
    ],
  });
} else if (expectedProviderVersion === undefined) {
  blocked("expected_dsh_version_missing", {
    required_argument: "--expected-dsh-version <version>",
    reason: "the observed binary version may not define its own expected contract",
  });
} else {
  let providerVersion;
  try {
    providerVersion = execFileSync(dshExecutable, ["--version"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    blocked("dsh_executable_missing_or_unusable", {
      command: `${basename(dshExecutable)} --version`,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (providerVersion !== undefined && providerVersion !== expectedProviderVersion) {
    blocked("dsh_version_contract_mismatch", {
      expected_version: expectedProviderVersion,
      expected_version_source: "cli_argument",
      observed_version: providerVersion,
    });
  }

  if (providerVersion === expectedProviderVersion) {
    let buildProvenance;
    let buildRoot;
    try {
      buildRoot = createCleanBuildRoot(implementationCommit);
      buildProvenance = collectPackageBuildProvenance({
        repositoryRoot,
        buildRoot,
        implementationCommit,
        packages: [{ name: "universal-harness", path: "packages/cli" }],
      });
      if (
        !buildProvenance.source_head_matches_implementation_commit ||
        !buildProvenance.tracked_source_clean ||
        !buildProvenance.clean_rebuild_from_committed_archive
      ) {
        blocked("runtime_build_commit_mismatch", { build_provenance: buildProvenance });
      }
    } catch (error) {
      blocked("runtime_build_failed", {
        command: "pnpm build",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (
      buildProvenance !== undefined &&
      buildRoot !== undefined &&
      buildProvenance.source_head_matches_implementation_commit &&
      buildProvenance.tracked_source_clean &&
      buildProvenance.clean_rebuild_from_committed_archive
    ) {
      const [
        { createDshAgentAdapter },
        { contentDigest },
        { assessUnattendedEligibility },
        runtime,
        { createGitRepositoryInspector },
      ] = await Promise.all([
        import(pathToFileURL(join(buildRoot, "adapters/agent-dsh/dist/index.js")).href),
        import(pathToFileURL(join(buildRoot, "packages/core/dist/index.js")).href),
        import(pathToFileURL(join(buildRoot, "packages/plugin-sdk/dist/index.js")).href),
        import(pathToFileURL(join(buildRoot, "packages/runtime/dist/index.js")).href),
        import(pathToFileURL(join(buildRoot, "packages/cli/dist/project-agent.js")).href),
      ]);
      const { buildTaskEnvelope, resolveLoopPolicy } = runtime;
      const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "harness-m4-dogfood-")));
      absolutePaths.push(scratchRoot);
      try {
        execFileSync("git", ["init", "-q"], { cwd: scratchRoot });
        execFileSync("git", ["config", "user.name", "Harness M4 Dogfood"], {
          cwd: scratchRoot,
        });
        execFileSync("git", ["config", "user.email", "harness@example.invalid"], {
          cwd: scratchRoot,
        });
        mkdirSync(join(scratchRoot, "src", "dogfood"), { recursive: true });
        writeFileSync(join(scratchRoot, "README.md"), "# M4 dogfood target\n", "utf8");
        writeFileSync(join(scratchRoot, ".gitignore"), ".harness/\n", "utf8");
        execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: scratchRoot });
        execFileSync("git", ["commit", "-qm", "baseline"], { cwd: scratchRoot });
        const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: scratchRoot,
          encoding: "utf8",
        }).trim();

        const inspector = createGitRepositoryInspector();
        const adapter = createDshAgentAdapter({
          executable: dshExecutable,
          launcher_args: [],
          expected_version: expectedProviderVersion,
          worktree: scratchRoot,
          evidence_dir: join(scratchRoot, ".harness", "raw-traces", "agent-dsh"),
          inspector,
          env_allowlist: [
            "DEEPSEEK_API_KEY",
            "DEEPSEEK_MODEL",
            "DSH_HOME",
            "HOME",
            "LANG",
            "LC_ALL",
            "PATH",
            "TMPDIR",
          ],
          timeout_ms: 180_000,
        });
        const eligibility = assessUnattendedEligibility(adapter.manifest);
        const expectedPath = "src/dogfood/probe.ts";
        const expectedBytes = "export const m4DogfoodProbe = 'real-dsh';\n";
        const envelope = buildTaskEnvelope({
          task_id: "task_real_dsh_probe",
          plan_id: "plan_m4_dogfood",
          iteration_id: "iteration_m4_dogfood",
          repository_id: "repository_m4_dogfood",
          baseline_id: baseline,
          objective:
            "Write exactly these UTF-8 bytes to src/dogfood/probe.ts, with no markdown fence, comment, or other file change: export const m4DogfoodProbe = 'real-dsh'; followed by one newline.",
          expected_output:
            "src/dogfood/probe.ts is a regular file containing exactly the requested bytes",
          acceptance_criteria: [
            "the requested file is a contained regular file with exact bytes",
            "no other path changes except the adapter's exact raw transcript locator",
          ],
          dependency_task_ids: [],
          required_gate_ids: [],
          input_node_revisions: {},
          context_bundle_id: "context_m4_dogfood",
          context_bundle_digest: contentDigest({ context: "m4-dogfood" }),
          protected_context_fields: [],
          allowed_read_paths: ["README.md", "src"],
          proposed_write_paths: ["src/dogfood"],
          state_read_fields: [],
          state_proposal_fields: [],
          tools: [],
          risk: "low",
          required_approval_digests: [],
          external_side_effect: "forbidden",
          idempotency_scope: "m4-real-dsh-probe",
          loop_policy: resolveLoopPolicy(
            { fields: [], layers: [], digest: contentDigest({ policy: "m4-dogfood" }) },
            {
              overrides: { max_steps: 12, max_tokens: 20_000, max_duration_ms: 180_000 },
              authorization_digest: contentDigest({ authorization: "m4-dogfood" }),
            },
          ),
          baseline_commit: baseline,
          input_digest: contentDigest({ task: "m4-real-dsh-probe" }),
          stale_input_behavior: "block",
        });
        const transcriptRelativePath =
          ".harness/raw-traces/agent-dsh/transcript-task_real_dsh_probe.json";
        const proofBoundary = captureWorkspaceProofBoundary({ repositoryRoot: scratchRoot });
        const dshSessionBoundary = captureDshSessionBoundary({ sessionRoot: dshSessionRoot });
        const result = await adapter.run(envelope, { mode: "supervised" });
        const dshSessionEvidence = readDshInvocationEvidence({
          sessionRoot: dshSessionRoot,
          beforeBoundary: dshSessionBoundary,
          requestedProviderModel: process.env.DEEPSEEK_MODEL,
        });
        const transcriptEvidence = result.evidence.find((entry) => entry.kind === "transcript");
        const transcript =
          transcriptEvidence === undefined
            ? undefined
            : JSON.parse(readFileSync(transcriptEvidence.locator, "utf8"));
        const probeVerification = verifyProbeWorkspace({
          repositoryRoot: scratchRoot,
          expectedPath,
          expectedBytes,
          baselineCommit: baseline,
          beforeBoundary: proofBoundary,
          allowedRawTracePaths: [transcriptRelativePath],
        });
        const probePassed =
          result.outcome === "handoff" &&
          result.termination_reason === "completion" &&
          probeVerification.status === "passed";
        const evidence = {
          command: `${dshExecutable} --profile headless <TaskEnvelope>`,
          exit_code: transcript?.exit_code ?? null,
          provider: "dsh",
          provider_profile: "headless",
          provider_backend: dshSessionEvidence.provider,
          provider_model: dshSessionEvidence.model,
          provider_model_source: dshSessionEvidence.identity_source,
          requested_provider_model: dshSessionEvidence.requested_model,
          requested_provider_model_source: loadedEnvNames.has("DEEPSEEK_MODEL")
            ? "project_dotenv_injected_process_env"
            : "preexisting_process_env",
          requested_provider_model_matches_observed:
            dshSessionEvidence.requested_model_matches_observed,
          expected_provider_version: expectedProviderVersion,
          expected_provider_version_source: "cli_argument",
          observed_provider_version: providerVersion,
          credential_source: loadedEnvNames.has("DEEPSEEK_API_KEY")
            ? "project_dotenv_injected_process_env"
            : "preexisting_process_env",
          credential_material_recorded: false,
          credential_material_hashed: false,
          build_provenance: buildProvenance,
          adapter_manifest: adapter.manifest,
          adapter_manifest_digest: contentDigest({ adapter_manifest: adapter.manifest }),
          requested_task_count: 4,
          requested_max_concurrency: 2,
          requested_wave_count: 3,
          effective_max_concurrency: eligibility.eligible ? 2 : 1,
          unattended_eligible: eligibility.eligible,
          eligibility_reasons: eligibility.reasons,
          provider_probe: {
            verification_status: probePassed ? "verified" : "failed",
            task_id: envelope.task_id,
            agent_outcome_claim: result.outcome,
            termination_reason: result.termination_reason,
            verification: probeVerification,
          },
          scheduler_eligibility: {
            status: eligibility.eligible ? "eligible" : "blocked",
            unattended_eligible: eligibility.eligible,
            reasons: eligibility.reasons,
            ac_06: eligibility.eligible ? "pending_full_dogfood" : "blocked",
            ac_20: eligibility.eligible ? "pending_full_dogfood" : "blocked",
            prerequisite_status: eligibility.eligible ? "eligible_not_executed" : "blocked",
          },
          adapter_reported_usage: {
            metering: result.usage.metering,
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            total_tokens: result.usage.total_tokens,
          },
          dsh_session_observation: {
            source: dshSessionEvidence.session_observation_source,
            session_sha256: dshSessionEvidence.session_sha256,
            raw_session_persisted_in_release_bundle:
              dshSessionEvidence.raw_session_persisted_in_release_bundle,
            usage: dshSessionEvidence.usage,
          },
          supervised_probe: {
            task_id: envelope.task_id,
            outcome: result.outcome,
            termination_reason: result.termination_reason,
            output_exists: probeVerification.output_exists,
            exact_bytes_match: probeVerification.exact_bytes_match,
            only_allowed_path_changed: probeVerification.only_allowed_path_changed,
            changed_paths: result.change_summary.paths,
            evidence: result.evidence.map((entry) => ({ kind: entry.kind, digest: entry.digest })),
            duration_ms: result.usage.duration_ms,
          },
          overlap_intervals: [],
          overlap_proven: false,
          raw_transcript_persisted_in_release_bundle: false,
          command_executable_basename: basename(dshExecutable),
        };
        if (!probePassed) blocked("real_provider_probe_failed", evidence);
        else if (!dshSessionEvidence.requested_model_matches_observed) {
          blocked("provider_model_contract_mismatch", evidence);
        } else if (!eligibility.eligible) blocked("real_adapter_unattended_ineligible", evidence);
        else blocked("full_four_task_scheduler_dogfood_not_executed", evidence);
      } catch (error) {
        blocked("real_provider_probe_error", {
          command: `${dshExecutable} --profile headless <TaskEnvelope>`,
          error: error instanceof Error ? error.message : String(error),
          build_provenance: buildProvenance,
        });
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
    if (buildRoot !== undefined) {
      rmSync(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
