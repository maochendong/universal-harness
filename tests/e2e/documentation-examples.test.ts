import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Documentation examples as tests (plan Task 28 step 3): every executable
 * example referenced from the docs runs here against the built CLI public
 * API. `pnpm verify` builds before testing, so `dist` is always present;
 * running this file standalone requires a prior `pnpm build`.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const EXAMPLES = ["new-project", "adopt-project", "manual-adapter", "command-adapter"] as const;

describe("documentation examples", () => {
  for (const example of EXAMPLES) {
    it(`examples/${example}/run.mjs completes`, { timeout: 240_000 }, () => {
      const script = join(repositoryRoot, "examples", example, "run.mjs");
      expect(
        existsSync(join(repositoryRoot, "packages", "cli", "dist", "index.js")),
        "examples exercise the built CLI; run pnpm build first",
      ).toBe(true);
      const output = execFileSync(process.execPath, [script], {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 180_000,
      });
      expect(output).toContain(`${example} example passed`);
    });
  }
});
