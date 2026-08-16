import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "dashboard-readonly.test.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] === undefined ? 0 : 1,
  reporter: "list",
  outputDir: ".reports/playwright-results",
  use: {
    channel: "chrome",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
});
