import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function configured(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Resolve a portable default while preserving explicit CLI-over-environment precedence. */
export function resolveDshExecutable(input) {
  return configured(input.argument) ?? configured(input.environment) ?? "dsh";
}

function changedPaths(repositoryRoot) {
  const tracked = execFileSync("git", ["diff", "--name-only", "-z", "HEAD", "--"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))].sort();
}

/** Independently verify the provider probe against literal expected bytes and its one-file scope. */
export function verifyProbeWorkspace(input) {
  if (isAbsolute(input.expectedPath) || input.expectedPath.split("/").includes("..")) {
    throw new Error("expectedPath must be a repository-relative path without traversal");
  }
  const repositoryRoot = resolve(input.repositoryRoot);
  const absolute = resolve(repositoryRoot, input.expectedPath);
  if (relative(repositoryRoot, absolute).startsWith("..")) {
    throw new Error("expectedPath escapes the repository root");
  }
  const paths = changedPaths(repositoryRoot);
  const exists = existsSync(absolute);
  const actualBytes = exists ? readFileSync(absolute) : undefined;
  const expectedBytes = Buffer.from(input.expectedBytes, "utf8");
  const exactBytes = actualBytes !== undefined && actualBytes.equals(expectedBytes);
  const onlyAllowedPath = paths.length === 1 && paths[0] === input.expectedPath;
  return {
    status: exactBytes && onlyAllowedPath ? "passed" : "failed",
    expected_path: input.expectedPath,
    changed_paths: paths,
    output_exists: exists,
    exact_bytes_match: exactBytes,
    only_allowed_path_changed: onlyAllowedPath,
    expected_bytes_sha256: sha256(expectedBytes),
    actual_bytes_sha256: actualBytes === undefined ? null : sha256(actualBytes),
  };
}

/** Bind the exact built entries and their committed source trees to one implementation commit. */
export function collectPackageBuildProvenance(input) {
  const repositoryRoot = resolve(input.repositoryRoot);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const trackedStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const packages = input.packages.map((entry) => {
    const packageJson = resolve(repositoryRoot, entry.path, "package.json");
    const distEntry = resolve(repositoryRoot, entry.path, "dist", "index.js");
    if (!existsSync(packageJson) || !existsSync(distEntry)) {
      throw new Error(`package ${entry.name} has no package.json or built dist/index.js`);
    }
    const sourceTreeOid = execFileSync(
      "git",
      ["rev-parse", `${input.implementationCommit}:${entry.path}`],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();
    return {
      name: entry.name,
      path: entry.path,
      source_tree_oid: sourceTreeOid,
      package_json_sha256: sha256(readFileSync(packageJson)),
      dist_entry_sha256: sha256(readFileSync(distEntry)),
    };
  });
  const proof = {
    implementation_commit: input.implementationCommit,
    source_head: head,
    source_head_matches_implementation_commit: head === input.implementationCommit,
    tracked_source_clean: trackedStatus === "",
    build_command: "pnpm build",
    packages,
  };
  return { ...proof, provenance_sha256: sha256(Buffer.from(JSON.stringify(proof), "utf8")) };
}
