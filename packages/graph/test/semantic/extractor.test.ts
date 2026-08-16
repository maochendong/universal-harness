import { describe, expect, it } from "vitest";

import {
  extractSemanticFeatures,
  normalizeSemanticTokens,
  weightedJaccard,
} from "../../src/index.js";

describe("semantic feature extraction", () => {
  it("normalizes NFKC, camelCase, snake_case and path segments deterministically", () => {
    expect(normalizeSemanticTokens("Ｃａｆｅ́User_HTTP/src/APIClient.ts")).toEqual([
      "api",
      "café",
      "client",
      "http",
      "src",
      "ts",
      "user",
    ]);
  });

  it("extracts declarations, exports, imports, paths and Markdown words", () => {
    const features = extractSemanticFeatures({
      locator: "repo://repository_01/src/user/UserService.ts",
      content: [
        'import { HttpClient } from "@app/http-client";',
        "export class UserService {}",
        "export function loadUserProfile() {}",
        "# User Profile API",
      ].join("\n"),
    });

    expect(features.symbols).toEqual(
      expect.arrayContaining(["http", "client", "user", "service", "load", "profile"]),
    );
    expect(features.imports).toEqual(expect.arrayContaining(["app", "http", "client"]));
    expect(features.paths).toEqual(expect.arrayContaining(["src", "user", "service", "ts"]));
    expect(features.terms).toEqual(expect.arrayContaining(["profile", "api"]));
    expect(features.symbols).toEqual([...features.symbols].sort());
  });

  it("computes fixed-point weighted Jaccard with the documented weights", () => {
    const score = weightedJaccard(
      { symbols: ["api"], imports: ["http"], paths: ["src"], terms: ["guide"] },
      { symbols: ["api"], imports: ["http"], paths: ["lib"], terms: ["guide"] },
    );

    expect(score).toEqual({ numerator: 14, denominator: 20, millionths: 700_000 });
  });
});
