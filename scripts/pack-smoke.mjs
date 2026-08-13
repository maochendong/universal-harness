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
 *    each drive to a completed snapshot through the real approval pauses.
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

  const newFirst = runHarness(
    ["new", "smoke-app", "--intent", "build the first capability"],
    sandbox,
  );
  if (newFirst.json.status !== "approval_required") {
    fail(`harness new did not pause for approval: ${JSON.stringify(newFirst.json)}`);
  }
  const newResult = drivePastApprovals(newFirst, join(sandbox, "smoke-app"));
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
    ["adopt", "legacy-app", "--intent", "introduce the requested change"],
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
      "--approve",
      adoptFirst.json.data.staging_operation_id,
    ],
    sandbox,
  );
  drivePastApprovals(adoptCommitted, legacyRoot);
  const snapshot = runHarness(["snapshot"], legacyRoot);
  if (snapshot.json.status !== "ok" || snapshot.json.data.status !== "completed") {
    fail(`adopt loop ended without a completed snapshot: ${JSON.stringify(snapshot.json)}`);
  }

  console.log(
    "Pack smoke passed: offline install, harness binary, ESM exports, " +
      "harness new and harness adopt completed their loops.",
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
