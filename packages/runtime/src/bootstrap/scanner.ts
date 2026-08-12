import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { LocatorError, normalizeLocatorPath, sha256Hex } from "@universal-harness-internal/core";

/**
 * Deterministic worktree scanner (design section 12.2). The scan is pure
 * file-system observation: it never writes, never follows symlinks, and never
 * enters VCS internals or cache directories. For the same repository content
 * and configuration it always produces the same file list, classifications,
 * component grouping, stack profile and semantic edge proposal input, so the
 * resulting baseline node IDs and digests are reproducible across runs and
 * platforms.
 */
export const STACK_PROFILES = ["generic", "node", "python", "java"] as const;
export type StackProfile = (typeof STACK_PROFILES)[number];

export type FileClassification = "source" | "test" | "config" | "documentation";

export interface ScannedFile {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly classification: FileClassification;
  /** Language tag for source and test files. */
  readonly language?: string;
  /** Import specifiers extracted deterministically; semantic edge proposal input. */
  readonly references: readonly string[];
}

export interface ScannedComponent {
  /** Top-level directory containing source or test files. */
  readonly path: string;
  readonly fileCount: number;
}

export interface ScanConflict {
  readonly path: string;
  readonly reason: string;
}

export interface UnknownItem {
  readonly path: string;
  readonly reason: string;
}

export interface ScanResult {
  readonly stack: {
    readonly primary: StackProfile;
    readonly detected: readonly StackProfile[];
  };
  /** Sorted by path. */
  readonly files: readonly ScannedFile[];
  /** Sorted by path. */
  readonly components: readonly ScannedComponent[];
  /** Scanned entries that cannot become canonical locators; sorted by path. */
  readonly conflicts: readonly ScanConflict[];
  /** Recognized files with no deterministic classification; sorted by path. */
  readonly unknownItems: readonly UnknownItem[];
}

/** Directories that are VCS internals, harness state or reproducible caches. */
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".harness",
  ".idea",
  ".vscode",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  ".gradle",
  ".next",
  ".turbo",
  "target",
  "dist",
  "coverage",
]);

/** Files larger than this are reported as unknown instead of hashed. */
const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".java": "java",
};

const CONFIG_FILE_NAMES = new Set([
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".node-version",
  ".nvmrc",
  ".editorconfig",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
]);

const DOCUMENTATION_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst", ".adoc"]);

const TEST_DIRECTORY_SEGMENTS = new Set(["test", "tests", "__tests__"]);

function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isTestFile(path: string): boolean {
  const segments = path.split("/");
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }
  const basename = basenameOf(path);
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(basename) ||
    /^test_.*\.py$/u.test(basename) ||
    /_test\.py$/u.test(basename) ||
    /Tests?\.java$/u.test(basename)
  );
}

const IMPORT_PATTERNS: Readonly<Record<string, readonly RegExp[]>> = {
  typescript: [
    /(?:import|export)\s[^'"]*?\bfrom\s*["']([^"']+)["']/gu,
    /import\s*["']([^"']+)["']/gu,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
  ],
  javascript: [
    /(?:import|export)\s[^'"]*?\bfrom\s*["']([^"']+)["']/gu,
    /import\s*["']([^"']+)["']/gu,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
  ],
  python: [/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gmu, /^\s*import\s+([A-Za-z_][\w.]*)/gmu],
  java: [/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gmu],
};

/** Extract import specifiers deterministically (sorted, de-duplicated). */
export function extractReferences(language: string, content: string): string[] {
  const patterns = IMPORT_PATTERNS[language] ?? [];
  const references = new Set<string>();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const reference = match[1];
      if (reference !== undefined) references.add(reference);
    }
  }
  return [...references].sort();
}

function classify(
  path: string,
): { classification: FileClassification; language?: string } | undefined {
  const extension = extensionOf(path);
  const language = LANGUAGE_BY_EXTENSION[extension];
  if (language !== undefined) {
    return isTestFile(path)
      ? { classification: "test", language }
      : { classification: "source", language };
  }
  if (CONFIG_FILE_NAMES.has(basenameOf(path))) return { classification: "config" };
  if (DOCUMENTATION_EXTENSIONS.has(extension)) return { classification: "documentation" };
  return undefined;
}

interface RawEntry {
  readonly path: string;
  readonly size: number;
  readonly content: Buffer;
}

function walk(root: string, directory: string, prefix: string, entries: RawEntry[]): void {
  const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const child of children) {
    const relative = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
    const absolute = join(directory, child.name);
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(child.name)) continue;
      walk(root, absolute, relative, entries);
    } else if (child.isFile()) {
      const size = statSync(absolute).size;
      if (size > MAX_SCANNED_FILE_BYTES) {
        entries.push({ path: relative, size, content: Buffer.alloc(0) });
        continue;
      }
      entries.push({ path: relative, size, content: readFileSync(absolute) });
    }
  }
}

function detectStack(paths: readonly string[]): readonly StackProfile[] {
  const names = new Set(paths.map(basenameOf));
  const detected: StackProfile[] = [];
  if (names.has("package.json")) detected.push("node");
  if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("setup.py")) {
    detected.push("python");
  }
  if (names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts")) {
    detected.push("java");
  }
  return detected;
}

/**
 * Scan a repository worktree. `root` must be an existing directory; the
 * result contains only deterministic observations, so two scans of identical
 * content always agree byte-for-byte.
 */
export function scanWorktree(root: string): ScanResult {
  const rawEntries: RawEntry[] = [];
  walk(root, root, "", rawEntries);

  const files: ScannedFile[] = [];
  const conflicts: ScanConflict[] = [];
  const unknownItems: UnknownItem[] = [];
  const canonicalOwners = new Map<string, string>();

  for (const entry of rawEntries) {
    if (entry.size > MAX_SCANNED_FILE_BYTES) {
      unknownItems.push({ path: entry.path, reason: "file_too_large" });
      continue;
    }
    if (entry.content.includes(0)) {
      unknownItems.push({ path: entry.path, reason: "binary_file" });
      continue;
    }
    let canonicalPath: string;
    try {
      canonicalPath = normalizeLocatorPath(entry.path);
    } catch (error) {
      const reason = error instanceof LocatorError ? error.reason : String(error);
      conflicts.push({ path: entry.path, reason: `illegal_locator: ${reason}` });
      continue;
    }
    const owner = canonicalOwners.get(canonicalPath);
    if (owner !== undefined) {
      conflicts.push({
        path: entry.path,
        reason: `locator_collision: canonical path already claimed by ${owner}`,
      });
      continue;
    }
    canonicalOwners.set(canonicalPath, entry.path);

    const classified = classify(canonicalPath);
    if (classified === undefined) {
      unknownItems.push({ path: canonicalPath, reason: "unrecognized_file_type" });
      continue;
    }
    const content = entry.content.toString("utf8");
    files.push({
      path: canonicalPath,
      sha256: sha256Hex(content),
      size: entry.size,
      classification: classified.classification,
      ...(classified.language === undefined ? {} : { language: classified.language }),
      references:
        classified.language === undefined ? [] : extractReferences(classified.language, content),
    });
  }

  const componentCounts = new Map<string, number>();
  for (const file of files) {
    if (file.classification !== "source" && file.classification !== "test") continue;
    const slash = file.path.indexOf("/");
    if (slash === -1) continue;
    const component = file.path.slice(0, slash);
    componentCounts.set(component, (componentCounts.get(component) ?? 0) + 1);
  }
  const components: ScannedComponent[] = [...componentCounts.entries()]
    .map(([path, fileCount]) => ({ path, fileCount }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));

  const detected = detectStack(files.map((file) => file.path));
  return {
    stack: { primary: detected[0] ?? "generic", detected },
    files,
    components,
    conflicts: [...conflicts].sort((left, right) => (left.path < right.path ? -1 : 1)),
    unknownItems: [...unknownItems].sort((left, right) => (left.path < right.path ? -1 : 1)),
  };
}
