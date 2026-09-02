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
import { fileURLToPath } from "node:url";

import { redactM4Evidence } from "./dogfood-m4-redaction.mjs";
import {
  collectPackageBuildProvenance,
  resolveDshExecutable,
  verifyProbeWorkspace,
} from "./m4-dogfood-proof.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliArgs = process.argv.slice(2);
const argValue = (name) => {
  const index = cliArgs.indexOf(name);
  return index === -1 ? undefined : cliArgs[index + 1];
};

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match === null || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
  }
}

loadDotEnv(join(repositoryRoot, ".env"));

const dshExecutable = resolveDshExecutable({
  argument: argValue("--dsh"),
  environment: process.env.HARNESS_DSH_EXECUTABLE,
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

  if (providerVersion !== undefined) {
    let buildProvenance;
    try {
      execFileSync("pnpm", ["build"], { cwd: repositoryRoot, stdio: "pipe" });
      buildProvenance = collectPackageBuildProvenance({
        repositoryRoot,
        implementationCommit,
        packages: [
          { name: "adapter-agent-dsh", path: "adapters/agent-dsh" },
          { name: "core", path: "packages/core" },
          { name: "plugin-sdk", path: "packages/plugin-sdk" },
          { name: "runtime", path: "packages/runtime" },
        ],
      });
      if (
        !buildProvenance.source_head_matches_implementation_commit ||
        !buildProvenance.tracked_source_clean
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
      buildProvenance.source_head_matches_implementation_commit &&
      buildProvenance.tracked_source_clean
    ) {
      const [
        { createDshAgentAdapter },
        { contentDigest },
        { assessUnattendedEligibility },
        runtime,
      ] = await Promise.all([
        import("../adapters/agent-dsh/dist/index.js"),
        import("../packages/core/dist/index.js"),
        import("../packages/plugin-sdk/dist/index.js"),
        import("../packages/runtime/dist/index.js"),
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

        const inspector = {
          inspect(root) {
            const head = execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: root,
              encoding: "utf8",
            }).trim();
            const entries = execFileSync(
              "git",
              ["status", "--porcelain", "-z", "--untracked-files=all"],
              { cwd: root, encoding: "utf8" },
            )
              .split("\0")
              .filter(Boolean)
              .map((entry) => entry.slice(3))
              .sort();
            return Promise.resolve({
              head,
              changed_paths: entries,
              digest: contentDigest({ head, entries }),
            });
          },
        };
        const adapter = createDshAgentAdapter({
          executable: dshExecutable,
          launcher_args: [],
          expected_version: providerVersion,
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
            "Create src/dogfood/probe.ts exporting const m4DogfoodProbe = 'real-dsh' and do not change any other file.",
          expected_output: "src/dogfood/probe.ts contains the requested TypeScript export",
          acceptance_criteria: ["the requested file exists", "no other path changes"],
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
        const result = await adapter.run(envelope, { mode: "supervised" });
        const transcriptEvidence = result.evidence.find((entry) => entry.kind === "transcript");
        const transcript =
          transcriptEvidence === undefined
            ? undefined
            : JSON.parse(readFileSync(transcriptEvidence.locator, "utf8"));
        const probeVerification = verifyProbeWorkspace({
          repositoryRoot: scratchRoot,
          expectedPath,
          expectedBytes,
        });
        const probePassed =
          result.outcome === "handoff" &&
          result.termination_reason === "completion" &&
          probeVerification.status === "passed";
        const evidence = {
          command: `${dshExecutable} --profile headless <TaskEnvelope>`,
          exit_code: transcript?.exit_code ?? null,
          provider: "dsh",
          provider_version: providerVersion,
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
            status: probePassed ? "passed" : "failed",
            task_id: envelope.task_id,
            outcome: result.outcome,
            termination_reason: result.termination_reason,
            verification: probeVerification,
          },
          scheduler_eligibility: {
            status: eligibility.eligible ? "eligible" : "blocked",
            unattended_eligible: eligibility.eligible,
            reasons: eligibility.reasons,
            ac_06: eligibility.eligible ? "pending_full_dogfood" : "blocked",
            ac_20: eligibility.eligible ? "pending_full_dogfood" : "blocked",
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
        else if (!eligibility.eligible) blocked("real_adapter_unattended_ineligible", evidence);
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
  }
}
