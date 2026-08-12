import { describe, expect, it } from "vitest";

import {
  LocatorError,
  buildLocator,
  canonicalizeLocator,
  normalizeLocatorPath,
  parseLocator,
} from "../../src/identity/locator.js";

describe("locator parsing and building", () => {
  it("pins golden canonical locators", () => {
    expect(canonicalizeLocator("repo://repository_01K1BBBB/src\\index.ts")).toBe(
      "repo://repository_01K1BBBB/src/index.ts",
    );
    expect(canonicalizeLocator("repo://repository_01K1BBBB/src/index.ts#symbol=App.render")).toBe(
      "repo://repository_01K1BBBB/src/index.ts#symbol=App.render",
    );
    expect(canonicalizeLocator("repo://repository_01K1BBBB")).toBe("repo://repository_01K1BBBB");
  });

  it("round-trips through parse and build", () => {
    const locator = "repo://repository_01/src/index.ts#api=get:/users/{id}";
    expect(buildLocator(parseLocator(locator))).toBe(locator);
    expect(parseLocator(locator)).toEqual({
      repository_id: "repository_01",
      path: "src/index.ts",
      qualifier: { kind: "api", value: "get:/users/{id}" },
    });
  });

  it("normalizes Windows path separators and drops dot segments", () => {
    expect(normalizeLocatorPath("src\\lib\\util.ts")).toBe("src/lib/util.ts");
    expect(normalizeLocatorPath("./src/./index.ts")).toBe("src/index.ts");
  });

  it("normalizes Unicode to NFC across path and fragment", () => {
    const composed = canonicalizeLocator("repo://repository_01/src/Caf\u00e9.ts");
    const decomposed = canonicalizeLocator("repo://repository_01/src/Cafe\u0301.ts");
    expect(composed).toBe(decomposed);
    expect(composed).toContain("Caf\u00e9.ts");
  });

  it("rejects inputs that escape the repository boundary", () => {
    for (const input of [
      "/etc/passwd",
      "\\\\server\\\\share",
      "../secret",
      "src/../../etc/passwd",
      "..",
      ".",
      "./.",
    ]) {
      expect(() => normalizeLocatorPath(input), input).toThrow(LocatorError);
    }
  });

  it("rejects ambiguous drive prefixes", () => {
    for (const input of ["C:/src/index.ts", "c:\\src", "D:relative"]) {
      expect(() => normalizeLocatorPath(input), input).toThrow(LocatorError);
    }
    // A single-letter first segment without a colon is a legitimate directory.
    expect(normalizeLocatorPath("x/index.ts")).toBe("x/index.ts");
  });

  it("rejects empty segments, control characters and reserved characters", () => {
    for (const input of [
      "src//index.ts",
      "src/",
      "src/i\u0000nvalid.ts",
      "src/what?.ts",
      "src/a#b.ts",
      "src/100%.ts",
    ]) {
      expect(() => normalizeLocatorPath(input), input).toThrow(LocatorError);
    }
  });

  it("rejects illegal symbol fragments", () => {
    for (const locator of [
      "repo://repository_01/src/index.ts#symbol=1bad",
      "repo://repository_01/src/index.ts#symbol=foo..bar",
      "repo://repository_01/src/index.ts#symbol=",
      "repo://repository_01/src/index.ts#unknown=x",
      "repo://repository_01/src/index.ts#noequals",
      "repo://repository_01/src/index.ts#symbol=a#b",
    ]) {
      expect(() => parseLocator(locator), locator).toThrow(LocatorError);
    }
  });

  it("rejects malformed authorities", () => {
    for (const locator of [
      "src/index.ts",
      "https://example.com/x",
      "repo://",
      "repo://not-an-identifier!/x",
    ]) {
      expect(() => parseLocator(locator), locator).toThrow(LocatorError);
    }
  });
});
