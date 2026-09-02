import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

function gitPaths(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function posixRelative(root, absolute) {
  return relative(root, absolute).split(sep).join("/");
}

function reservedEntries(repositoryRoot) {
  const entries = [];
  const visit = (absolute) => {
    if (!existsSync(absolute)) return;
    const path = posixRelative(repositoryRoot, absolute);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      entries.push({ path, type: "symlink" });
      return;
    }
    if (stat.isFile()) {
      entries.push({ path, type: "file", digest: sha256(readFileSync(absolute)) });
      return;
    }
    if (!stat.isDirectory()) {
      entries.push({ path, type: "non_regular" });
      return;
    }
    for (const child of readdirSync(absolute).sort()) visit(resolve(absolute, child));
  };
  visit(resolve(repositoryRoot, ".git"));
  visit(resolve(repositoryRoot, ".harness"));
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/** Freeze the reserved stores and Git head before an external provider runs. */
export function captureWorkspaceProofBoundary(input) {
  const repositoryRoot = realpathSync(resolve(input.repositoryRoot));
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  return {
    repository_root: repositoryRoot,
    head,
    reserved_entries: reservedEntries(repositoryRoot),
  };
}

function changedReservedPaths(before, after) {
  const previous = new Map(before.map((entry) => [entry.path, JSON.stringify(entry)]));
  const current = new Map(after.map((entry) => [entry.path, JSON.stringify(entry)]));
  return [...new Set([...previous.keys(), ...current.keys()])]
    .filter((path) => previous.get(path) !== current.get(path))
    .sort();
}

function inspectOutput(repositoryRoot, path) {
  const absolute = resolve(repositoryRoot, path);
  if (!existsSync(absolute)) {
    return { exists: false, regular: false, contained: false, bytes: undefined };
  }
  const regular = lstatSync(absolute).isFile();
  let contained;
  try {
    const real = realpathSync(absolute);
    contained = real !== repositoryRoot && !posixRelative(repositoryRoot, real).startsWith("../");
  } catch {
    contained = false;
  }
  return {
    exists: true,
    regular,
    contained,
    bytes: regular && contained ? readFileSync(absolute) : undefined,
  };
}

/** Independently verify the provider probe against literal expected bytes and its one-file scope. */
export function verifyProbeWorkspace(input) {
  if (isAbsolute(input.expectedPath) || input.expectedPath.split("/").includes("..")) {
    throw new Error("expectedPath must be a repository-relative path without traversal");
  }
  const repositoryRoot = realpathSync(resolve(input.repositoryRoot));
  if (input.beforeBoundary.repository_root !== repositoryRoot) {
    throw new Error("beforeBoundary belongs to a different repository root");
  }
  const absolute = resolve(repositoryRoot, input.expectedPath);
  if (relative(repositoryRoot, absolute).startsWith("..")) {
    throw new Error("expectedPath escapes the repository root");
  }
  const allowedRawTracePaths = new Set(input.allowedRawTracePaths);
  for (const path of allowedRawTracePaths) {
    if (
      isAbsolute(path) ||
      path.split("/").includes("..") ||
      !path.startsWith(".harness/raw-traces/")
    ) {
      throw new Error(`raw transcript whitelist path is invalid: ${path}`);
    }
  }
  const tracked = gitPaths(repositoryRoot, [
    "diff",
    "--name-only",
    "-z",
    input.baselineCommit,
    "--",
  ]);
  const untracked = gitPaths(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = gitPaths(repositoryRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  const observedPaths = [...new Set([...tracked, ...untracked, ...ignored])].sort();
  const rawTracePaths = observedPaths.filter((path) => allowedRawTracePaths.has(path));
  const taskPaths = observedPaths.filter((path) => !allowedRawTracePaths.has(path));
  const output = inspectOutput(repositoryRoot, input.expectedPath);
  const actualBytes = output.bytes;
  const expectedBytes = Buffer.from(input.expectedBytes, "utf8");
  const exactBytes = actualBytes !== undefined && actualBytes.equals(expectedBytes);
  const changedReserved = changedReservedPaths(
    input.beforeBoundary.reserved_entries,
    reservedEntries(repositoryRoot),
  );
  const unauthorizedReserved = changedReserved.filter(
    (path) => path.startsWith(".git/") || !allowedRawTracePaths.has(path),
  );
  const invalidWorkspaceEntries = taskPaths.filter((path) => {
    const inspected = inspectOutput(repositoryRoot, path);
    return inspected.exists && (!inspected.regular || !inspected.contained);
  });
  const unauthorizedPaths = [
    ...taskPaths.filter((path) => path !== input.expectedPath),
    ...unauthorizedReserved,
    ...invalidWorkspaceEntries,
  ];
  const currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (currentHead !== input.beforeBoundary.head) unauthorizedPaths.push(".git/HEAD");
  const uniqueUnauthorized = [...new Set(unauthorizedPaths)].sort();
  const onlyAllowedPath =
    taskPaths.length === 1 &&
    taskPaths[0] === input.expectedPath &&
    uniqueUnauthorized.length === 0;
  return {
    status: exactBytes && onlyAllowedPath ? "passed" : "failed",
    expected_path: input.expectedPath,
    changed_paths: taskPaths,
    observed_paths: observedPaths,
    raw_trace_paths: rawTracePaths,
    unauthorized_paths: uniqueUnauthorized,
    output_exists: output.exists,
    output_regular_file: output.regular,
    output_realpath_contained: output.contained,
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
