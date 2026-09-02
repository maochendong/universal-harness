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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDshAgentAdapter } from "../adapters/agent-dsh/dist/index.js";
import { contentDigest } from "../packages/core/dist/index.js";
import { assessUnattendedEligibility } from "../packages/plugin-sdk/dist/index.js";
import { buildTaskEnvelope, resolveLoopPolicy } from "../packages/runtime/dist/index.js";

import { redactM4Evidence } from "./dogfood-m4-redaction.mjs";

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

const dshExecutable =
  argValue("--dsh") ??
  process.env.HARNESS_DSH_EXECUTABLE ??
  "/Users/Darkknight/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh";
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
} else if (!existsSync(dshExecutable) || !statSync(dshExecutable).isFile()) {
  blocked("dsh_executable_missing", { command: `${dshExecutable} --version` });
} else if (!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_MODEL) {
  blocked("provider_configuration_missing", {
    missing: [
      ...(!process.env.DEEPSEEK_API_KEY ? ["DEEPSEEK_API_KEY"] : []),
      ...(!process.env.DEEPSEEK_MODEL ? ["DEEPSEEK_MODEL"] : []),
    ],
  });
} else {
  const providerVersion = execFileSync(dshExecutable, ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
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
    execFileSync("git", ["add", "README.md"], { cwd: scratchRoot });
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
    const outputExists = existsSync(join(scratchRoot, "src", "dogfood", "probe.ts"));
    const evidence = {
      command: `${dshExecutable} --profile headless <TaskEnvelope>`,
      exit_code: transcript?.exit_code ?? null,
      provider: "dsh",
      provider_version: providerVersion,
      adapter_manifest: adapter.manifest,
      adapter_manifest_digest: contentDigest({ adapter_manifest: adapter.manifest }),
      requested_task_count: 4,
      requested_max_concurrency: 2,
      requested_wave_count: 3,
      effective_max_concurrency: eligibility.eligible ? 2 : 1,
      unattended_eligible: eligibility.eligible,
      eligibility_reasons: eligibility.reasons,
      supervised_probe: {
        task_id: envelope.task_id,
        outcome: result.outcome,
        termination_reason: result.termination_reason,
        output_exists: outputExists,
        changed_paths: result.change_summary.paths,
        evidence: result.evidence.map((entry) => ({ kind: entry.kind, digest: entry.digest })),
        duration_ms: result.usage.duration_ms,
      },
      overlap_intervals: [],
      overlap_proven: false,
      raw_transcript_persisted_in_release_bundle: false,
      command_executable_basename: basename(dshExecutable),
    };
    if (!eligibility.eligible) blocked("real_adapter_unattended_ineligible", evidence);
    else if (result.outcome !== "handoff" || !outputExists)
      blocked("real_provider_probe_failed", evidence);
    else blocked("full_four_task_scheduler_dogfood_not_executed", evidence);
  } catch (error) {
    blocked("real_provider_probe_error", {
      command: `${dshExecutable} --profile headless <TaskEnvelope>`,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
