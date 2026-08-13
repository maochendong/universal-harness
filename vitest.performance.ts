import { defineConfig } from "vitest/config";

/**
 * Performance release gate (design 16.2, plan Task 27). These tests measure
 * hard thresholds, so they must run in isolation: parallel workers executing
 * the rest of the suite would make wall-clock measurements non-deterministic.
 * The default `pnpm test` run excludes this directory; the gate runs through
 * `pnpm test:performance` with file parallelism disabled.
 */
export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    include: ["tests/performance/**/*.test.ts"],
    fileParallelism: false,
    passWithNoTests: false,
    reporters: ["default", "./tests/reporting/vitest-acceptance-reporter.ts"],
  },
});
