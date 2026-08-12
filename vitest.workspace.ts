import { defineConfig } from "vitest/config";

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
    passWithNoTests: false,
  },
});
