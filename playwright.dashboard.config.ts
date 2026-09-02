import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: [
    "dashboard-readonly.test.ts",
    "dashboard-live-approval.test.ts",
    "dashboard-m3-collaboration.test.ts",
    "dashboard-m4-scheduler.test.ts",
    "dashboard-m4-governed-controls.test.ts",
  ],
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] === undefined ? 0 : 1,
  reporter: [["list"], ["./tests/reporting/playwright-acceptance-reporter.ts"]],
  outputDir: ".reports/playwright-results",
  use: {
    channel: "chrome",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
});
