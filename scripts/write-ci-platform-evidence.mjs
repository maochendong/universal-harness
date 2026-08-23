import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "ci-platform-evidence.v1";
const EXPECTED_KEYS = [
  "artifact_digest",
  "command",
  "commit",
  "exit_status",
  "platform",
  "schema_version",
  "workflow",
];

function evidenceContent(input) {
  return {
    schema_version: SCHEMA_VERSION,
    commit: input.commit,
    workflow: input.workflow,
    platform: input.platform,
    command: input.command,
    exit_status: input.exit_status,
  };
}

function digestOf(content) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function buildCiPlatformEvidence(input) {
  const content = evidenceContent(input);
  return { ...content, artifact_digest: digestOf(content) };
}

function validArtifact(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EXPECTED_KEYS)) return false;
  if (value.schema_version !== SCHEMA_VERSION) return false;
  if (typeof value.commit !== "string" || !/^[a-f0-9]{40}$/u.test(value.commit)) return false;
  if (value.workflow !== "CI" || value.command !== "pnpm verify") return false;
  if (typeof value.platform !== "string" || value.platform.length === 0) return false;
  if (!Number.isInteger(value.exit_status) || value.exit_status < 0) return false;
  if (typeof value.artifact_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.artifact_digest)) {
    return false;
  }
  return value.artifact_digest === digestOf(evidenceContent(value));
}

/**
 * Release truth evaluator. Absence, malformed artifacts and commit drift are
 * unknown proof (`not_verified`); a valid same-commit non-zero result is a
 * proved failure. Only the complete same-commit three-platform set passes.
 */
export function evaluateCiPlatformEvidence(input) {
  const required = [...new Set(input.required_platforms)].sort();
  const valid = [];
  let invalidArtifacts = 0;
  for (const artifact of input.artifacts) {
    if (!validArtifact(artifact)) invalidArtifacts += 1;
    else valid.push(artifact);
  }
  if (invalidArtifacts > 0) {
    return {
      status: "not_verified",
      invalid_artifacts: invalidArtifacts,
      missing_platforms: [],
      drifted_platforms: [],
      failed_platforms: [],
    };
  }
  const byPlatform = new Map();
  for (const artifact of valid) {
    if (!required.includes(artifact.platform) || byPlatform.has(artifact.platform)) {
      return {
        status: "not_verified",
        invalid_artifacts: 1,
        missing_platforms: [],
        drifted_platforms: [],
        failed_platforms: [],
      };
    }
    byPlatform.set(artifact.platform, artifact);
  }
  const missingPlatforms = required.filter((platform) => !byPlatform.has(platform));
  if (missingPlatforms.length > 0) {
    return {
      status: "not_verified",
      invalid_artifacts: 0,
      missing_platforms: missingPlatforms,
      drifted_platforms: [],
      failed_platforms: [],
    };
  }
  const driftedPlatforms = required.filter(
    (platform) => byPlatform.get(platform).commit !== input.current_commit,
  );
  if (driftedPlatforms.length > 0) {
    return {
      status: "not_verified",
      invalid_artifacts: 0,
      missing_platforms: [],
      drifted_platforms: driftedPlatforms,
      failed_platforms: [],
    };
  }
  const failedPlatforms = required.filter((platform) => byPlatform.get(platform).exit_status !== 0);
  return {
    status: failedPlatforms.length === 0 ? "passed" : "failed",
    invalid_artifacts: 0,
    missing_platforms: [],
    drifted_platforms: [],
    failed_platforms: failedPlatforms,
  };
}

function argsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error("arguments must be supplied as --key value pairs");
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function main() {
  const args = argsOf(process.argv.slice(2));
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const commit =
    args.commit ??
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const platform = args.platform;
  if (platform === undefined) throw new Error("--platform is required");
  const exitStatus = Number(args["exit-status"]);
  if (!Number.isInteger(exitStatus) || exitStatus < 0) {
    throw new Error("--exit-status must be a non-negative integer");
  }
  const output = resolve(repositoryRoot, args.output ?? `.reports/ci-platform/${platform}.json`);
  const evidence = buildCiPlatformEvidence({
    commit,
    workflow: args.workflow ?? "CI",
    platform,
    command: args.command ?? "pnpm verify",
    exit_status: exitStatus,
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`CI platform evidence written: ${output}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `ci platform evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
