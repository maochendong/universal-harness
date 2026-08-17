import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    include: [
      "tests/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "adapters/**/test/**/*.test.ts",
      "packs/**/test/**/*.test.ts",
    ],
    exclude: [
      ...configDefaults.exclude,
      "tests/performance/**",
      "tests/e2e/dashboard-readonly.test.ts",
      "tests/e2e/dashboard-live-approval.test.ts",
    ],
    // Git-heavy repository fixtures compete for disk and process capacity at
    // Vitest's eight-worker default. Cap concurrency so the release gate stays
    // below the tests' intentional 5s/30s operation timeouts on developer Macs.
    maxWorkers: 4,
    passWithNoTests: false,
    // Plan Task 28: every run also emits the structured acceptance evidence
    // consumed by scripts/generate-acceptance-report.mjs.
    reporters: ["default", "./tests/reporting/vitest-acceptance-reporter.ts"],
  },
});
