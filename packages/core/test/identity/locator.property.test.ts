import { describe, expect, it } from "vitest";

import {
  LocatorError,
  canonicalizeLocator,
  normalizeLocatorPath,
} from "../../src/identity/locator.js";
import { mulberry32, pick, randomInt } from "./seeds.js";

const SAFE_SEGMENTS = ["src", "lib", "index.ts", "util-1", "README.md", "x", "0", "a.b.c"];

function randomPath(random: () => number, separator: string): string {
  const length = randomInt(random, 4) + 1;
  return Array.from({ length }, () => pick(random, SAFE_SEGMENTS)).join(separator);
}

describe("locator normalization properties", () => {
  it("separator spelling never changes the canonical path", () => {
    const random = mulberry32(7);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const separators = Array.from({ length: 4 }, () => (random() < 0.5 ? "/" : "\\"));
      const segments = Array.from({ length: randomInt(random, 4) + 1 }, () =>
        pick(random, SAFE_SEGMENTS),
      );
      const slashForm = segments.join("/");
      const mixedForm = `${segments[0] ?? ""}${segments
        .slice(1)
        .map((segment, index) => `${separators[index] ?? "/"}${segment}`)
        .join("")}`;
      expect(normalizeLocatorPath(mixedForm)).toBe(normalizeLocatorPath(slashForm));
    }
  });

  it("normalized output never escapes the repository boundary", () => {
    const random = mulberry32(99);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const separator = random() < 0.5 ? "/" : "\\";
      const path = randomPath(random, separator);
      const normalized = normalizeLocatorPath(path);
      expect(normalized.startsWith("/")).toBe(false);
      expect(normalized.split("/")).not.toContain("..");
      expect(normalized).not.toContain("\\");
      expect(normalized).not.toMatch(/^[A-Za-z]:/);
    }
  });

  it("malicious inputs are always rejected", () => {
    const random = mulberry32(31337);
    const attacks: Array<(path: string) => string> = [
      (path) => `/${path}`,
      (path) => `\\${path}`,
      (path) => `../${path}`,
      (path) => `${path}/..`,
      (path) => `${path}/../../x`,
      (path) => `C:/${path}`,
      (path) => `d:\\${path}`,
      (path) => `${path}//tail`,
      (path) => `${path}/`,
      (path) => `${path}\n`,
    ];
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const path = randomPath(random, "/");
      const attack = pick(random, attacks)(path);
      expect(() => normalizeLocatorPath(attack), attack).toThrow(LocatorError);
    }
  });

  it("canonicalization is idempotent", () => {
    const random = mulberry32(2026);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const locator = `repo://repository_01/${randomPath(random, random() < 0.5 ? "/" : "\\")}`;
      const canonical = canonicalizeLocator(locator);
      expect(canonicalizeLocator(canonical)).toBe(canonical);
    }
  });
});
