import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = [
  "packages/cli",
  "packages/core",
  "packages/graph",
  "packages/runtime",
  "packages/eval",
  "packages/plugin-sdk",
  "packages/conformance",
  "adapters/agent-manual",
  "adapters/agent-command",
  "adapters/vcs-git",
  "adapters/projection-markdown",
  "packs/generic",
  "packs/node",
  "packs/python",
  "packs/java",
];

for (const directory of packageDirectories) {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, directory, "package.json"), "utf8"),
  );
  const importPath = manifest.exports?.["."]?.import;
  if (typeof manifest.name !== "string" || typeof importPath !== "string") {
    throw new Error(`${directory} does not declare a named ESM export`);
  }

  const module = await import(pathToFileURL(join(repositoryRoot, directory, importPath)).href);
  if (module.workspacePackageName !== manifest.name) {
    throw new Error(`${manifest.name} public export did not resolve to its canonical identity`);
  }
}

console.log(`Resolved public exports for ${packageDirectories.length} workspace packages.`);
