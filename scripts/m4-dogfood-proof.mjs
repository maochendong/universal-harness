import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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

/** Expected version is an independent project/CLI contract, never the binary's self-report. */
export function resolveExpectedDshVersion(input) {
  return configured(input.argument);
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

function fileTree(root, options = {}) {
  if (!existsSync(root)) throw new Error(`tree does not exist: ${root}`);
  const files = [];
  const visit = (absolute) => {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`tree contains a symlink: ${absolute}`);
    if (stat.isDirectory()) {
      if (options.skipNodeModules && absolute !== root && absolute.endsWith(`${sep}node_modules`)) {
        return;
      }
      for (const child of readdirSync(absolute).sort()) visit(resolve(absolute, child));
      return;
    }
    if (!stat.isFile()) throw new Error(`tree contains a non-regular entry: ${absolute}`);
    files.push({ path: posixRelative(root, absolute), sha256: sha256(readFileSync(absolute)) });
  };
  visit(root);
  return files;
}

function packageCatalog(root) {
  const catalog = new Map();
  for (const collection of ["adapters", "packages", "packs"]) {
    const collectionRoot = resolve(root, collection);
    if (!existsSync(collectionRoot)) continue;
    for (const entry of readdirSync(collectionRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${collection}/${entry.name}`;
      const packageJson = resolve(root, path, "package.json");
      if (!existsSync(packageJson)) continue;
      const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
      if (typeof manifest.name === "string") catalog.set(manifest.name, { path, manifest });
    }
  }
  return catalog;
}

function internalDependencyClosure(catalog, roots) {
  const byName = new Map(roots.map((entry) => [entry.name, entry]));
  const queue = [...roots.map((entry) => entry.name)];
  while (queue.length > 0) {
    const name = queue.shift();
    const entry = byName.get(name) ?? catalog.get(name);
    if (entry === undefined) throw new Error(`runtime package ${name} is not in the workspace`);
    byName.set(name, { name, path: entry.path });
    const catalogEntry = catalog.get(name);
    const dependencies = catalogEntry?.manifest.dependencies ?? {};
    for (const dependency of Object.keys(dependencies).sort()) {
      if (catalog.has(dependency) && !byName.has(dependency)) {
        const target = catalog.get(dependency);
        byName.set(dependency, { name: dependency, path: target.path });
        queue.push(dependency);
      }
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function externalDependencyProof(buildRoot, manifests, internalNames) {
  const queue = [];
  for (const { path, manifest } of manifests) {
    for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (!internalNames.has(name)) queue.push({ name, from: resolve(buildRoot, path) });
    }
  }
  const seen = new Set();
  const proof = [];
  while (queue.length > 0) {
    const candidate = queue.shift();
    const require = createRequire(resolve(candidate.from, "package.json"));
    let packageJson;
    try {
      packageJson = require.resolve(`${candidate.name}/package.json`);
    } catch {
      let cursor = require.resolve(candidate.name);
      while (cursor !== resolve(cursor, "..")) {
        const possible = resolve(cursor, "..", "package.json");
        if (existsSync(possible)) {
          const parsed = JSON.parse(readFileSync(possible, "utf8"));
          if (parsed.name === candidate.name) {
            packageJson = possible;
            break;
          }
        }
        cursor = resolve(cursor, "..");
      }
    }
    if (packageJson === undefined) {
      throw new Error(`cannot resolve runtime dependency ${candidate.name} from ${candidate.from}`);
    }
    const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
    const identity = `${String(manifest.name)}@${String(manifest.version)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const packageRoot = resolve(packageJson, "..");
    const files = fileTree(packageRoot, { skipNodeModules: true });
    proof.push({
      name: manifest.name,
      version: manifest.version,
      package_tree_sha256: sha256(Buffer.from(JSON.stringify(files), "utf8")),
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      queue.push({ name: dependency, from: packageRoot });
    }
  }
  return proof.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
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
  const buildRoot = resolve(input.buildRoot ?? repositoryRoot);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const trackedStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const catalog = packageCatalog(repositoryRoot);
  const closure = internalDependencyClosure(catalog, input.packages);
  const manifests = closure.map((entry) => {
    const packageJson = resolve(repositoryRoot, entry.path, "package.json");
    if (!existsSync(packageJson)) throw new Error(`package ${entry.name} has no package.json`);
    return { ...entry, manifest: JSON.parse(readFileSync(packageJson, "utf8")) };
  });
  const packages = manifests.map((entry) => {
    const packageJson = resolve(repositoryRoot, entry.path, "package.json");
    const distRoot = resolve(buildRoot, entry.path, "dist");
    if (!existsSync(distRoot)) {
      throw new Error(`package ${entry.name} has no emitted dist tree`);
    }
    const sourceTreeOid = execFileSync(
      "git",
      ["rev-parse", `${input.implementationCommit}:${entry.path}`],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();
    const emittedFiles = fileTree(distRoot);
    if (emittedFiles.length === 0) throw new Error(`package ${entry.name} emitted no files`);
    return {
      name: entry.name,
      path: entry.path,
      source_tree_oid: sourceTreeOid,
      package_json_sha256: sha256(readFileSync(packageJson)),
      emitted_tree_sha256: sha256(Buffer.from(JSON.stringify(emittedFiles), "utf8")),
      emitted_files: emittedFiles,
    };
  });
  const internalNames = new Set(closure.map((entry) => entry.name));
  const lockfile = resolve(repositoryRoot, "pnpm-lock.yaml");
  const rootManifest = resolve(repositoryRoot, "package.json");
  const proof = {
    implementation_commit: input.implementationCommit,
    source_head: head,
    source_head_matches_implementation_commit: head === input.implementationCommit,
    tracked_source_clean: trackedStatus === "",
    build_command: "pnpm build",
    clean_rebuild_from_committed_archive:
      buildRoot !== repositoryRoot && !existsSync(resolve(buildRoot, ".git")),
    root_package_json_sha256: sha256(readFileSync(rootManifest)),
    lockfile_sha256: sha256(readFileSync(lockfile)),
    runtime_dependency_closure: closure.map((entry) => entry.name),
    packages,
    external_runtime_dependencies: externalDependencyProof(buildRoot, manifests, internalNames),
  };
  return { ...proof, provenance_sha256: sha256(Buffer.from(JSON.stringify(proof), "utf8")) };
}
