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
      "tests/e2e/dashboard-m3-collaboration.test.ts",
      "tests/e2e/dashboard-m4-scheduler.test.ts",
    ],
    // Git-heavy repository fixtures compete for disk and process capacity at
    // Vitest's eight-worker default. Cap concurrency so the release gate stays
    // below the tests' intentional 5s/30s operation timeouts on developer Macs.
    maxWorkers: 4,
    // Windows runners have a 2-3x slower filesystem; raise the default 5s
    // per-test timeout there only, leaving POSIX behavior untouched.
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
    passWithNoTests: false,
    // Plan Task 28: every run also emits the structured acceptance evidence
    // consumed by scripts/generate-acceptance-report.mjs.
    reporters: ["default", "./tests/reporting/vitest-acceptance-reporter.ts"],
  },
});
