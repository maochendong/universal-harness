import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/coverage/**", "**/dist/**", "**/node_modules/**"],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    // teach*/ assets are browser scripts, not Node scripts.
    files: ["teach/**/*.js", "teach-v2/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        IntersectionObserver: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        requestAnimationFrame: "readonly",
        window: "readonly",
      },
    },
    rules: {
      // Course scripts intentionally bind unused catch params as `_error`.
      "no-unused-vars": ["error", { caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrorsIgnorePattern: "^_" }],
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
