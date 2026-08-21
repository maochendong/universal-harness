import { describe, expect, it } from "vitest";

import {
  attestWriteSet,
  canonicalTestPatch,
  classifyPath,
  validateTestAuthoringPatch,
} from "../../src/tdd/patch.js";

/**
 * T15 canonical test patch (provable TDD design 8.2): test authoring may
 * touch test and test-config paths only; immutable paths always win; a
 * co-located test file inside the production tree still classifies as test.
 * The canonical patch digest is order-insensitive and content-bound, so the
 * same patch is reused and any post-acceptance drift is detectable.
 */
const POLICY = {
  test: ["tests/**"],
  test_config: ["vitest.config.ts"],
  production: ["src/**"],
  immutable: ["migrations/**"],
};

describe("classifyPath", () => {
  it("classifies by policy scopes with immutable first", () => {
    expect(classifyPath("tests/items.test.ts", POLICY)).toBe("test");
    expect(classifyPath("vitest.config.ts", POLICY)).toBe("test_config");
    expect(classifyPath("src/items.ts", POLICY)).toBe("production");
    expect(classifyPath("migrations/001.sql", POLICY)).toBe("immutable");
    expect(classifyPath("README.md", POLICY)).toBeUndefined();
  });

  it("treats a co-located test file in the production tree as test scope", () => {
    expect(classifyPath("src/items/items.test.ts", POLICY)).toBe("test");
    expect(classifyPath("src/items/items.spec.ts", POLICY)).toBe("test");
    expect(classifyPath("src/items/items.ts", POLICY)).toBe("production");
  });

  it("lets immutable beat a test-looking name", () => {
    expect(classifyPath("migrations/001.test.ts", POLICY)).toBe("immutable");
  });
});

describe("validateTestAuthoringPatch", () => {
  it("accepts test and test-config only patches", () => {
    expect(
      validateTestAuthoringPatch(
        [
          { path: "tests/items.test.ts", content: "test" },
          { path: "vitest.config.ts", content: "config" },
        ],
        POLICY,
      ),
    ).toEqual([]);
  });

  it("rejects production, immutable, unclassified and escaping paths", () => {
    const codes = (paths: string[]) =>
      validateTestAuthoringPatch(
        paths.map((path) => ({ path, content: "x" })),
        POLICY,
      ).map((issue) => issue.code);
    expect(codes(["src/items.ts"])).toContain("production_write");
    expect(codes(["migrations/001.sql"])).toContain("immutable_write");
    expect(codes(["docs/readme.md"])).toContain("unclassified_path");
    expect(codes(["../outside.ts"])).toContain("path_escape");
  });
});

describe("canonicalTestPatch", () => {
  it("is order-insensitive and content-bound", () => {
    const files = [
      { path: "tests/b.test.ts", content: "b" },
      { path: "tests/a.test.ts", content: "a" },
    ];
    const first = canonicalTestPatch(files);
    const shuffled = canonicalTestPatch([...files].reverse());
    expect(shuffled.patch_digest).toBe(first.patch_digest);
    expect(first.patch_digest).toMatch(/^[a-f0-9]{64}$/u);
    const changed = canonicalTestPatch([{ path: "tests/a.test.ts", content: "a2" }, files[1]!]);
    expect(changed.patch_digest).not.toBe(first.patch_digest);
  });
});

describe("attestWriteSet", () => {
  it("passes writes inside the grant and flags everything else", () => {
    expect(attestWriteSet(["tests/a.test.ts"], ["tests/**"])).toEqual([]);
    const violations = attestWriteSet(["src/items.ts", "tests/a.test.ts"], ["tests/**"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/items.ts");
  });
});
