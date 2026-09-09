/**
 * Transparency/SSE release-evidence gate (plan Task 6 Step 2/5).
 *
 * Verify mode (default): reloads the canonical suite reports, the tracked
 * evidence bytes at the recorded implementation commit and the generated
 * dogfood/release reports, then re-derives all seven HT-AC results and
 * requires the committed sidecar `docs/evidence/transparency-sse-completion.json`
 * plus its Markdown projection to match exactly. Any missing, failing, stale,
 * dirty or hand-edited evidence exits non-zero.
 *
 * Generate mode: `--generate --implementation-commit <sha>` re-derives the
 * same results and writes the JSON sidecar and Markdown only when every one
 * of the seven acceptance items genuinely passes; otherwise it exits
 * non-zero without writing a "passed" report.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRANSPARENCY_MARKDOWN_PATH,
  TRANSPARENCY_SIDECAR_PATH,
  TransparencyEvidenceError,
  buildTransparencyAcceptanceSidecar,
  renderTransparencyMarkdown,
  verifyTransparencyEvidence,
} from "./lib/transparency-evidence.mjs";
import { CANONICAL_RELEASE_COMMANDS } from "./lib/m4-release-evidence.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadSuiteReports(root) {
  const reports = new Map();
  for (const suite of Object.keys(CANONICAL_RELEASE_COMMANDS)) {
    const path = join(root, ".reports", "acceptance", `${suite}.json`);
    if (existsSync(path)) {
      reports.set(suite, JSON.parse(readFileSync(path, "utf8")));
    }
  }
  return reports;
}

function worktreeReader(root) {
  return (path) => {
    const absolute = join(root, path);
    return existsSync(absolute) ? readFileSync(absolute) : undefined;
  };
}

function parseArgs(argv) {
  const args = { generate: false, implementationCommit: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--generate") {
      args.generate = true;
    } else if (token === "--implementation-commit") {
      args.implementationCommit = argv[index + 1];
      index += 1;
    } else {
      throw new TransparencyEvidenceError(`unknown argument: ${token}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const suiteReports = loadSuiteReports(repositoryRoot);
  const readWorktreeBytes = worktreeReader(repositoryRoot);

  if (args.generate) {
    if (args.implementationCommit === undefined) {
      throw new TransparencyEvidenceError("--generate requires --implementation-commit <sha>");
    }
    const sidecar = buildTransparencyAcceptanceSidecar({
      repositoryRoot,
      implementationCommit: args.implementationCommit,
      suiteReports,
      readWorktreeBytes,
      generatedAt: new Date().toISOString(),
    });
    const notPassed = sidecar.results.filter((entry) => entry.status !== "passed");
    if (notPassed.length > 0) {
      for (const entry of notPassed) {
        console.error(`${entry.acceptance_id}: ${entry.status} — ${entry.detail}`);
      }
      throw new TransparencyEvidenceError(
        "source evidence is incomplete; refusing to generate a completion report",
      );
    }
    verifyTransparencyEvidence({
      repositoryRoot,
      sidecar,
      suiteReports,
      readWorktreeBytes,
    });
    writeFileSync(
      join(repositoryRoot, TRANSPARENCY_SIDECAR_PATH),
      `${JSON.stringify(sidecar, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(repositoryRoot, TRANSPARENCY_MARKDOWN_PATH),
      renderTransparencyMarkdown(sidecar),
      "utf8",
    );
    console.log(
      `generated ${TRANSPARENCY_SIDECAR_PATH} and ${TRANSPARENCY_MARKDOWN_PATH} for ${args.implementationCommit}`,
    );
    return;
  }

  const sidecarPath = join(repositoryRoot, TRANSPARENCY_SIDECAR_PATH);
  if (!existsSync(sidecarPath)) {
    throw new TransparencyEvidenceError(
      `${TRANSPARENCY_SIDECAR_PATH} is missing; run with --generate --implementation-commit <sha>`,
    );
  }
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  const markdownPath = join(repositoryRoot, TRANSPARENCY_MARKDOWN_PATH);
  if (!existsSync(markdownPath)) {
    throw new TransparencyEvidenceError(`${TRANSPARENCY_MARKDOWN_PATH} is missing`);
  }
  const markdown = readFileSync(markdownPath, "utf8");
  const { results } = verifyTransparencyEvidence({
    repositoryRoot,
    sidecar,
    suiteReports,
    readWorktreeBytes,
    markdown,
  });
  for (const entry of results) {
    console.log(`${entry.acceptance_id}: ${entry.status} — ${entry.detail}`);
  }
  console.log(`transparency evidence verified at ${sidecar.implementation_commit}`);
}

try {
  main();
} catch (error) {
  if (error instanceof TransparencyEvidenceError) {
    console.error(`verify:transparency failed: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
