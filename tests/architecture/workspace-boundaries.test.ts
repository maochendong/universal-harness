import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const expectedPackages = new Map([
  ["packages/cli", "universal-harness"],
  ["packages/core", "@universal-harness-internal/core"],
  ["packages/graph", "@universal-harness-internal/graph"],
  ["packages/runtime", "@universal-harness-internal/runtime"],
  ["packages/eval", "@universal-harness-internal/eval"],
  ["packages/plugin-sdk", "@universal-harness-internal/plugin-sdk"],
  ["packages/conformance", "@universal-harness-internal/conformance"],
  ["adapters/agent-manual", "@universal-harness-internal/adapter-agent-manual"],
  ["adapters/agent-command", "@universal-harness-internal/adapter-agent-command"],
  ["adapters/vcs-git", "@universal-harness-internal/adapter-vcs-git"],
  ["adapters/projection-markdown", "@universal-harness-internal/adapter-projection-markdown"],
  ["packs/generic", "@universal-harness-internal/pack-generic"],
  ["packs/node", "@universal-harness-internal/pack-node"],
  ["packs/python", "@universal-harness-internal/pack-python"],
  ["packs/java", "@universal-harness-internal/pack-java"],
]);

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  exports?: Record<string, { import?: string; types?: string }>;
};

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function readManifest(packageDirectory: string): PackageManifest {
  return JSON.parse(
    readFileSync(join(repositoryRoot, packageDirectory, "package.json"), "utf8"),
  ) as PackageManifest;
}

function internalDependencies(manifest: PackageManifest): string[] {
  return dependencyFields.flatMap((field) =>
    Object.keys(manifest[field] ?? {}).filter(
      (name) => name === "universal-harness" || name.startsWith("@universal-harness-internal/"),
    ),
  );
}

function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  function visit(node: string): string[] | undefined {
    if (active.has(node)) {
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return undefined;

    visited.add(node);
    active.add(node);
    path.push(node);
    for (const dependency of graph.get(node) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    active.delete(node);
    return undefined;
  }

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function sourceFiles(directory: string): string[] {
  const absoluteDirectory = join(repositoryRoot, directory);
  return readdirSync(absoluteDirectory).flatMap((entry) => {
    const absoluteEntry = join(absoluteDirectory, entry);
    if (statSync(absoluteEntry).isDirectory()) {
      return sourceFiles(relative(repositoryRoot, absoluteEntry));
    }
    return /\.[cm]?tsx?$/.test(entry) ? [absoluteEntry] : [];
  });
}

function crossPackagePrivateImports(packageDirectory: string): string[] {
  const ownRoot = resolve(repositoryRoot, packageDirectory);
  const workspaceRoots = [...expectedPackages.keys()].map((entry) =>
    resolve(repositoryRoot, entry),
  );
  const violations: string[] = [];

  for (const file of sourceFiles(`${packageDirectory}/src`)) {
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    for (const specifier of specifiers) {
      if (specifier === undefined) continue;
      if (
        /^(?:universal-harness|@universal-harness-internal\/[^/]+)\/src(?:\/|$)/.test(specifier)
      ) {
        violations.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      const targetPackage = workspaceRoots.find(
        (root) => target === root || target.startsWith(`${root}${sep}`),
      );
      if (targetPackage !== undefined && targetPackage !== ownRoot) {
        violations.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
      }
    }
  }
  return violations;
}

describe("workspace boundaries", () => {
  it("contains every designed package with its canonical name", () => {
    for (const [directory, expectedName] of expectedPackages) {
      const manifest = readManifest(directory);
      expect(manifest.name, directory).toBe(expectedName);
      expect(manifest.private, directory).toBe(directory !== "packages/cli");
      expect(manifest.exports?.["."]?.import, directory).toBe("./dist/index.js");
      expect(manifest.exports?.["."]?.types, directory).toBe("./dist/index.d.ts");
      expect(
        readFileSync(join(repositoryRoot, directory, "src/index.ts"), "utf8"),
        directory,
      ).toMatch(/export\s/u);
    }
  });

  it("has no cycles between workspace packages", () => {
    const graph = new Map<string, string[]>();
    for (const directory of expectedPackages.keys()) {
      const manifest = readManifest(directory);
      graph.set(manifest.name ?? directory, internalDependencies(manifest));
    }
    expect(findCycle(graph)).toBeUndefined();
  });

  it("does not import another package through a private source path", () => {
    const violations = [...expectedPackages.keys()].flatMap(crossPackagePrivateImports);
    expect(violations).toEqual([]);
  });
});
