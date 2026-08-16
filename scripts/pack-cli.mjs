/**
 * Build the publishable `universal-harness` tarball (M1 Task 28, M2 Task 11).
 *
 * The public npm package ships as one self-contained tarball: the CLI `dist`
 * plus every workspace-internal package and every third-party runtime
 * dependency staged under `node_modules` and declared in
 * `bundledDependencies`. Internal manifests are rewritten so `workspace:*`
 * and `catalog:` protocols never leak into the published artifact; the staged
 * tree contains compiled output only, never internal-only source.
 *
 * Output: `.pack/universal-harness-<version>.tgz` (`.pack/` is gitignored).
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packRoot = join(repositoryRoot, ".pack");
const stagingRoot = join(packRoot, "staging");
const stagingModules = join(stagingRoot, "node_modules");

function readManifest(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function readCatalog() {
  const workspaceFile = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const catalog = new Map();
  let inCatalog = false;
  for (const line of workspaceFile.split(/\r?\n/u)) {
    if (/^catalog:\s*$/u.test(line)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog) {
      if (/^\S/u.test(line)) break;
      const match = /^\s+"?([^"\s]+)"?:\s*(\S+)\s*$/u.exec(line);
      if (match !== null) catalog.set(match[1], match[2]);
    }
  }
  return catalog;
}

/** Map of every workspace package name to its directory and manifest. */
function readWorkspacePackages() {
  const groups = ["packages", "adapters", "packs"];
  const entries = new Map();
  for (const group of groups) {
    const groupRoot = join(repositoryRoot, group);
    for (const entry of readdirSorted(groupRoot)) {
      const directory = join(groupRoot, entry);
      const manifestPath = join(directory, "package.json");
      if (!existsSync(manifestPath)) continue;
      entries.set(readManifest(directory).name, { directory, manifest: readManifest(directory) });
    }
  }
  return entries;
}

function readdirSorted(directory) {
  return readdirSync(directory).sort();
}

/** Locate the installed package root for `name` as seen from `fromDir`. */
function resolvePackageDirectory(name, fromDir) {
  const require = createRequire(join(fromDir, "package.json"));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    let directory = dirname(require.resolve(name));
    for (;;) {
      const manifestPath = join(directory, "package.json");
      if (existsSync(manifestPath) && readManifest(directory).name === name) return directory;
      const parent = dirname(directory);
      if (parent === directory) {
        throw new Error(`cannot locate the package root of ${name} from ${fromDir}`);
      }
      directory = parent;
    }
  }
}

const catalog = readCatalog();
const workspacePackages = readWorkspacePackages();

function resolveDependencySpec(name, spec, owner) {
  if (spec.startsWith("workspace:")) {
    const target = workspacePackages.get(name);
    if (target === undefined)
      throw new Error(`${owner} depends on unknown workspace package ${name}`);
    return target.manifest.version;
  }
  if (spec === "catalog:" || spec.startsWith("catalog:")) {
    const resolved = catalog.get(name);
    if (resolved === undefined)
      throw new Error(`${owner} uses catalog dependency ${name} missing from the catalog`);
    return resolved;
  }
  return spec;
}

// --- Stage the tree ---------------------------------------------------------

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingModules, { recursive: true });
mkdirSync(packRoot, { recursive: true });

const cliDirectory = join(repositoryRoot, "packages", "cli");
const cliManifest = readManifest(cliDirectory);

const staged = new Map(); // package name -> staged version

/** Copy one third-party runtime dependency (and its own deps) into staging. */
function stageExternalDependency(name, fromDir) {
  const directory = realpathSync(resolvePackageDirectory(name, fromDir));
  const manifest = readManifest(directory);
  const known = staged.get(manifest.name);
  if (known !== undefined) {
    if (known !== manifest.version) {
      throw new Error(
        `conflicting versions staged for ${manifest.name}: ${known} and ${manifest.version}`,
      );
    }
    return;
  }
  staged.set(manifest.name, manifest.version);
  cpSync(directory, join(stagingModules, manifest.name), {
    recursive: true,
    dereference: true,
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    stageExternalDependency(dependency, directory);
  }
}

/** Copy one internal workspace package (compiled output only) into staging. */
function stageInternalPackage(name) {
  const entry = workspacePackages.get(name);
  if (entry === undefined) throw new Error(`unknown workspace package ${name}`);
  if (staged.has(name)) return;
  staged.set(name, entry.manifest.version);

  const destination = join(stagingModules, name);
  mkdirSync(destination, { recursive: true });
  for (const fileEntry of entry.manifest.files ?? []) {
    cpSync(join(entry.directory, fileEntry), join(destination, fileEntry), { recursive: true });
  }

  const dependencies = {};
  for (const [dependency, spec] of Object.entries(entry.manifest.dependencies ?? {})) {
    dependencies[dependency] = resolveDependencySpec(dependency, spec, name);
    if (spec.startsWith("workspace:")) {
      stageInternalPackage(dependency);
    } else {
      stageExternalDependency(dependency, entry.directory);
    }
  }

  const stagedManifest = {
    name: entry.manifest.name,
    version: entry.manifest.version,
    type: entry.manifest.type,
    exports: entry.manifest.exports,
    dependencies,
  };
  writeFileSync(
    join(destination, "package.json"),
    `${JSON.stringify(stagedManifest, null, 2)}\n`,
    "utf8",
  );
}

for (const [dependency, spec] of Object.entries(cliManifest.dependencies ?? {})) {
  if (spec.startsWith("workspace:")) {
    stageInternalPackage(dependency);
  } else {
    stageExternalDependency(dependency, cliDirectory);
  }
}

for (const required of [
  "@universal-harness-internal/dashboard",
  "@universal-harness-internal/adapter-gate-llm-judge",
]) {
  if (!staged.has(required)) {
    throw new Error(`M2 runtime dependency was not staged: ${required}`);
  }
}
for (const asset of ["dashboard.html", "dashboard.css", "dashboard.js"]) {
  const path = join(
    stagingModules,
    "@universal-harness-internal",
    "dashboard",
    "dist",
    "assets",
    asset,
  );
  if (!existsSync(path)) throw new Error(`M2 Dashboard asset was not staged: ${asset}`);
}

// --- Assemble the publishable package ---------------------------------------

for (const fileEntry of cliManifest.files ?? []) {
  cpSync(join(cliDirectory, fileEntry), join(stagingRoot, fileEntry), { recursive: true });
}
cpSync(join(repositoryRoot, "README.md"), join(stagingRoot, "README.md"));
cpSync(join(repositoryRoot, "LICENSE"), join(stagingRoot, "LICENSE"));

const stagedCliManifest = {
  name: cliManifest.name,
  version: cliManifest.version,
  description: cliManifest.description,
  license: cliManifest.license,
  repository: cliManifest.repository,
  keywords: cliManifest.keywords,
  engines: cliManifest.engines,
  publishConfig: cliManifest.publishConfig,
  type: cliManifest.type,
  exports: cliManifest.exports,
  bin: cliManifest.bin,
  files: cliManifest.files,
  // npm only packs bundled copies that are also declared as dependencies;
  // at install time the bundled copy satisfies the spec, so nothing is
  // fetched from a registry and the tarball stays fully self-contained.
  dependencies: Object.fromEntries([...staged.entries()].sort()),
  bundledDependencies: [...staged.keys()].sort(),
};
writeFileSync(
  join(stagingRoot, "package.json"),
  `${JSON.stringify(stagedCliManifest, null, 2)}\n`,
  "utf8",
);

// --- Pack -------------------------------------------------------------------

const tarballName = `${cliManifest.name}-${cliManifest.version}.tgz`;
rmSync(join(packRoot, tarballName), { force: true });
execFileSync("npm", ["pack", "--pack-destination", packRoot], {
  cwd: stagingRoot,
  stdio: "pipe",
});

console.log(`Packed ${tarballName} with ${String(staged.size)} bundled dependencies into .pack/.`);
