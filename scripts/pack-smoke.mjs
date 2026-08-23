/**
 * Pack smoke gate (plan Task 28): install the packed `universal-harness`
 * tarball into a clean temporary environment, offline, and prove the shipped
 * artifact works end to end.
 *
 * Assertions:
 *  - tarball contents: binary, ESM exports, README, LICENSE, bundled internal
 *    packages and third-party runtime deps; no internal-only source, tests,
 *    tsconfig or build metadata; no `workspace:`/`catalog:` protocols left
 *    in any staged manifest;
 *  - clean install resolves with `--offline` (fully self-contained tarball);
 *  - `harness --version` / `--help` work through the installed `.bin` shim and
 *    the package root imports as ESM with its canonical identity;
 *  - the two required vertical loop demos, `harness new` and `harness adopt`,
 *    first fail closed without an executor, then explicitly abort that sealed
 *    baseline, bind a deterministic dsh Agent, and complete a fresh iteration
 *    through the real approval pauses to a snapshot.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packRoot = join(repositoryRoot, ".pack");
const stagingRoot = join(packRoot, "staging");

const cliManifest = JSON.parse(
  readFileSync(join(repositoryRoot, "packages", "cli", "package.json"), "utf8"),
);
const tarball = join(packRoot, `${cliManifest.name}-${cliManifest.version}.tgz`);
if (!existsSync(tarball)) {
  throw new Error(`missing ${tarball}; run node scripts/pack-cli.mjs first`);
}

function fail(message) {
  throw new Error(`pack smoke failed: ${message}`);
}

// --- Tarball content scan -----------------------------------------------------

const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
  .split(/\r?\n/u)
  .filter(Boolean);

const requiredEntries = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/bin.js",
  "package/dist/index.js",
  "package/dist/public-api.js",
  "package/node_modules/@universal-harness-internal/core/package.json",
  "package/node_modules/@universal-harness-internal/core/schemas/node.schema.json",
  "package/node_modules/@universal-harness-internal/graph/dist/index.js",
  "package/node_modules/@universal-harness-internal/runtime/dist/index.js",
  "package/node_modules/@universal-harness-internal/adapter-agent-manual/dist/index.js",
  "package/node_modules/@universal-harness-internal/adapter-agent-command/dist/index.js",
  "package/node_modules/@universal-harness-internal/adapter-gate-llm-judge/dist/index.js",
  "package/node_modules/@universal-harness-internal/adapter-gate-llm-judge/dist/provider.js",
  "package/node_modules/@universal-harness-internal/dashboard/dist/index.js",
  "package/node_modules/@universal-harness-internal/dashboard/dist/server.js",
  "package/node_modules/@universal-harness-internal/dashboard/dist/assets/dashboard.html",
  "package/node_modules/@universal-harness-internal/dashboard/dist/assets/dashboard.css",
  "package/node_modules/@universal-harness-internal/dashboard/dist/assets/dashboard.js",
  "package/node_modules/ajv/package.json",
  "package/node_modules/@sinclair/typebox/package.json",
];
for (const entry of requiredEntries) {
  if (!entries.includes(entry)) fail(`tarball is missing ${entry}`);
}

// The internal-only source ban applies to our own code: the CLI dist and the
// bundled `@universal-harness-internal/*` packages. Third-party runtime deps
// ship as they were published (some include their own tsconfig or sources).
const ownEntry = (entry) =>
  entry.startsWith("package/dist/") ||
  entry.startsWith("package/node_modules/@universal-harness-internal/");
const forbiddenEntry = entries
  .filter(ownEntry)
  .find(
    (entry) =>
      /\/(?:src|test)\//u.test(entry) ||
      /\.tsbuildinfo$/u.test(entry) ||
      /(?:^|\/)tsconfig[^/]*\.json$/u.test(entry) ||
      (/\.ts$/u.test(entry) && !/\.d\.ts$/u.test(entry)),
  );
if (forbiddenEntry !== undefined) {
  fail(`tarball contains internal-only source or build metadata: ${forbiddenEntry}`);
}

// Distribution bytes must be relocatable and secret-free. Scan our compiled
// code/assets (third-party packages retain their upstream fixtures) for the
// build workspace and for credential values present in the pack environment.
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}
const ownFiles = [
  ...filesUnder(join(stagingRoot, "dist")),
  ...filesUnder(join(stagingRoot, "node_modules", "@universal-harness-internal")),
];
const credentialValues = Object.entries(process.env)
  .filter(
    ([name, value]) =>
      value !== undefined &&
      value.length >= 16 &&
      /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/u.test(name),
  )
  .map(([, value]) => value);
for (const path of ownFiles) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const content = bytes.toString("utf8");
  if (content.includes(repositoryRoot) || /\/Users\/[^/\s]+\//u.test(content)) {
    fail(`packed artifact contains an absolute workspace path: ${path}`);
  }
  if (credentialValues.some((value) => content.includes(value))) {
    fail(`packed artifact contains a credential value from the build environment: ${path}`);
  }
}

// --- Staged manifest hygiene --------------------------------------------------

const stagedManifests = [
  join(stagingRoot, "package.json"),
  ...readdirSync(join(stagingRoot, "node_modules"), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith("@")) {
      return readdirSync(join(stagingRoot, "node_modules", entry.name)).map((scoped) =>
        join(stagingRoot, "node_modules", entry.name, scoped, "package.json"),
      );
    }
    return [join(stagingRoot, "node_modules", entry.name, "package.json")];
  }),
];
for (const manifestPath of stagedManifests) {
  const content = readFileSync(manifestPath, "utf8");
  if (/workspace:|catalog:/u.test(content)) {
    fail(`staged manifest keeps a workspace-only protocol: ${manifestPath}`);
  }
}
const stagedCli = JSON.parse(readFileSync(join(stagingRoot, "package.json"), "utf8"));
if (!Array.isArray(stagedCli.bundledDependencies) || stagedCli.bundledDependencies.length === 0) {
  fail("staged CLI manifest does not declare bundledDependencies");
}
if (stagedCli.license !== "Apache-2.0" || stagedCli.repository?.url === undefined) {
  fail("staged CLI manifest misses provenance metadata (license, repository)");
}

// --- Clean offline install ------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "harness-pack-smoke-"));
const harnessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Harness Pack Smoke",
  GIT_AUTHOR_EMAIL: "harness-pack-smoke@example.com",
  GIT_COMMITTER_NAME: "Harness Pack Smoke",
  GIT_COMMITTER_EMAIL: "harness-pack-smoke@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

try {
  writeFileSync(
    join(sandbox, "package.json"),
    `${JSON.stringify({ name: "harness-pack-smoke", version: "0.0.0", type: "module" })}\n`,
    "utf8",
  );
  const install = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-save", "--offline", tarball],
    { cwd: sandbox, env: harnessEnv, encoding: "utf8", timeout: 180_000 },
  );
  if (install.status !== 0) {
    fail(`offline install failed:\n${install.stdout}\n${install.stderr}`);
  }

  const binName = process.platform === "win32" ? "harness.cmd" : "harness";
  const harnessBin = join(sandbox, "node_modules", ".bin", binName);
  if (!existsSync(harnessBin)) fail("installed package did not link the harness binary");

  function runHarness(args, cwd) {
    const result = spawnSync(harnessBin, [...args, "--json"], {
      cwd,
      env: harnessEnv,
      encoding: "utf8",
      timeout: 180_000,
    });
    if (result.error !== undefined)
      fail(`harness ${args.join(" ")} errored: ${result.error.message}`);
    let json;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      fail(`harness ${args.join(" ")} did not emit JSON:\n${result.stdout}\n${result.stderr}`);
    }
    return { status: result.status, json };
  }

  const version = spawnSync(harnessBin, ["--version"], {
    cwd: sandbox,
    env: harnessEnv,
    encoding: "utf8",
  });
  if (version.status !== 0 || !/^universal-harness \d+\.\d+\.\d+\s*$/u.test(version.stdout)) {
    fail(`harness --version misbehaved: ${version.stdout} ${version.stderr}`);
  }
  const help = spawnSync(harnessBin, ["--help"], {
    cwd: sandbox,
    env: harnessEnv,
    encoding: "utf8",
  });
  if (help.status !== 0 || !help.stdout.includes("Usage: harness")) {
    fail("harness --help misbehaved");
  }

  const esm = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { runCli, workspacePackageName } from 'universal-harness';" +
        "if (typeof runCli !== 'function' || workspacePackageName !== 'universal-harness') process.exit(1);",
    ],
    { cwd: sandbox, env: harnessEnv, encoding: "utf8" },
  );
  if (esm.status !== 0) fail(`ESM root export check failed:\n${esm.stderr}`);

  // --- Vertical loop demos ------------------------------------------------------

  function drivePastApprovals(first, projectRoot) {
    let result = first;
    for (let round = 0; result.json.status === "approval_required" && round < 8; round += 1) {
      const data = result.json.data;
      const approved = runHarness(
        ["approve", data.request_id, "--decision", "approve", "--actor", "human:pack-smoke"],
        projectRoot,
      );
      if (approved.json.status !== "ok") {
        fail(`approve failed: ${JSON.stringify(approved.json)}`);
      }
      result = runHarness(["resume", data.workflow_operation_id], projectRoot);
    }
    if (result.json.status !== "ok") {
      fail(`loop did not complete: ${JSON.stringify(result.json)}`);
    }
    return result.json;
  }

  function configureSmokeAgent(projectRoot) {
    const agentScript = join(projectRoot, "scripts", "pack-smoke-agent.mjs");
    mkdirSync(dirname(agentScript), { recursive: true });
    writeFileSync(
      agentScript,
      [
        'if (process.argv.includes("--version")) {',
        '  console.log("pack-smoke-dsh 1.0.0");',
        "} else {",
        '  console.log("deterministic packed agent completed the task");',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const configPath = join(projectRoot, ".harness", "runtime.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.runtime_config_version = 3;
    config.agent = {
      provider: "dsh",
      expected_version: "pack-smoke-dsh 1.0.0",
      executable: process.execPath,
      launcher_args: [agentScript],
      env_allowlist: ["HOME", "LANG", "PATH", "TMPDIR"],
      allowed_read_paths: [],
      proposed_write_paths: [],
    };
    config.gates = [];
    config.judge_gates = [];
    delete config.model_providers;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    execFileSync("git", ["add", ".harness/runtime.json", "scripts/pack-smoke-agent.mjs"], {
      cwd: projectRoot,
      env: harnessEnv,
    });
    execFileSync("git", ["commit", "-m", "chore: configure pack smoke executor"], {
      cwd: projectRoot,
      env: harnessEnv,
    });
  }

  function restartAfterExecutorBinding(blocked, projectRoot, intent) {
    if (
      blocked.json.status !== "blocked" ||
      blocked.json.data?.reason !== "missing_input" ||
      !String(blocked.json.data?.detail ?? "").includes("executor_required")
    ) {
      fail(`loop did not fail closed for a missing executor: ${JSON.stringify(blocked.json)}`);
    }
    const aborted = runHarness(["abort", blocked.json.data.workflow_operation_id], projectRoot);
    if (aborted.json.status !== "ok") {
      fail(`could not abort the sealed no-executor operation: ${JSON.stringify(aborted.json)}`);
    }
    configureSmokeAgent(projectRoot);
    return runHarness(["iterate", intent], projectRoot);
  }

  const newFirst = runHarness(
    ["new", "smoke-app", "--intent", "build the first capability", "--profile", "lite"],
    sandbox,
  );
  const newRoot = join(sandbox, "smoke-app");
  const newReady = restartAfterExecutorBinding(newFirst, newRoot, "complete the first capability");
  const newResult = drivePastApprovals(newReady, newRoot);
  if (typeof newResult.data.snapshot_id !== "string") {
    fail("harness new completed without a snapshot");
  }

  const legacyRoot = join(sandbox, "legacy-app");
  mkdirSync(join(legacyRoot, "src"), { recursive: true });
  writeFileSync(
    join(legacyRoot, "package.json"),
    `${JSON.stringify({ name: "legacy-app", version: "1.0.0", type: "module" })}\n`,
    "utf8",
  );
  writeFileSync(join(legacyRoot, "src", "index.js"), "export const answer = 42;\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: legacyRoot, env: harnessEnv });
  // Pin autocrlf off so the baseline stays clean on Windows runners, and
  // auto gc off so no detached maintenance races the sandbox cleanup.
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: legacyRoot, env: harnessEnv });
  execFileSync("git", ["config", "gc.auto", "0"], { cwd: legacyRoot, env: harnessEnv });
  execFileSync("git", ["add", "-A"], { cwd: legacyRoot, env: harnessEnv });
  execFileSync("git", ["commit", "-m", "legacy baseline"], { cwd: legacyRoot, env: harnessEnv });

  const adoptFirst = runHarness(
    ["adopt", "legacy-app", "--intent", "introduce the requested change", "--profile", "lite"],
    sandbox,
  );
  if (adoptFirst.json.status !== "approval_required") {
    fail(`harness adopt did not stage a preview: ${JSON.stringify(adoptFirst.json)}`);
  }
  const adoptCommitted = runHarness(
    [
      "adopt",
      "legacy-app",
      "--intent",
      "introduce the requested change",
      "--profile",
      "lite",
      "--approve",
      adoptFirst.json.data.staging_operation_id,
    ],
    sandbox,
  );
  const adoptReady = restartAfterExecutorBinding(
    adoptCommitted,
    legacyRoot,
    "complete the requested change",
  );
  drivePastApprovals(adoptReady, legacyRoot);
  const snapshot = runHarness(["snapshot"], legacyRoot);
  if (snapshot.json.status !== "ok" || snapshot.json.data.status !== "completed") {
    fail(`adopt loop ended without a completed snapshot: ${JSON.stringify(snapshot.json)}`);
  }

  const evidenceDirectory = join(repositoryRoot, ".reports", "acceptance");
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    join(evidenceDirectory, "pack-smoke.json"),
    `${JSON.stringify(
      {
        status: "passed",
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
          encoding: "utf8",
        }).trim(),
        tarball: tarball.split(/[\\/]/u).at(-1),
        dashboard_assets: ["dashboard.html", "dashboard.css", "dashboard.js"],
        judge_adapter: true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(
    "Pack smoke passed: offline install, harness binary, ESM exports, " +
      "harness new and harness adopt completed their loops.",
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
