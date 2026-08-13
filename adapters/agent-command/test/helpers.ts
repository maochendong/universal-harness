import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { contentDigest } from "@universal-harness-internal/core";

import type { CommandProviderManifest } from "../src/manifest.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(testDirectory, "fixtures");

const createdDirectories: string[] = [];

export function cleanupDirectories(): void {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}

export function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  createdDirectories.push(directory);
  return directory;
}

/** A capable delegated manifest running one fixture script through node. */
export function fixtureManifest(
  script: string,
  overrides: Partial<CommandProviderManifest> = {},
): CommandProviderManifest {
  return {
    provider: "fixture-provider",
    control: "delegated",
    trajectory_visibility: "summarized",
    usage_metering: true,
    side_effect_interception: true,
    resume_semantics: "explicit",
    executable: process.execPath,
    args: [join(FIXTURES, script), "{input_file}"],
    env_allowlist: [],
    ...overrides,
  };
}

/** Inspector that lists files in the worktree (repository-relative). */
export function directoryInspector(): {
  inspect(root: string): Promise<{
    head: string | null;
    changed_paths: string[];
    digest: string;
  }>;
} {
  return {
    inspect(root: string) {
      const walk = (directory: string, prefix: string): string[] =>
        readdirSync(directory).flatMap((entry) => {
          const absolute = join(directory, entry);
          const relative = prefix === "" ? entry : `${prefix}/${entry}`;
          return statSync(absolute).isDirectory() ? walk(absolute, relative) : [relative];
        });
      const paths = walk(root, "").sort();
      return Promise.resolve({
        head: null,
        changed_paths: paths,
        digest: contentDigest(paths),
      });
    },
  };
}
