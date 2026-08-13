import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  listRepositoryFiles,
  type ScannedArtifact,
  type ScannedRelation,
  type StackAdapter,
  type StackDetection,
  type StackScan,
} from "@universal-harness-internal/plugin-sdk";

import { NODE_PACK, NODE_PACK_MANIFEST } from "./pack.js";

/**
 * Node StackAdapter (design 13.1, plan Task 25 step 2). Detection is marker
 * based and scanning is pure file-system observation: no tool execution, no
 * writes, and every claim carries the repository-relative evidence it was
 * derived from. Test relations are deterministic path rules only
 * (`test/foo.test.ts` tests `src/foo.ts`), never inferred semantics.
 */

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

const CONFIG_FILE_NAMES: readonly string[] = [
  ".npmrc",
  ".node-version",
  ".nvmrc",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
];

const TEST_DIRECTORY_SEGMENTS: readonly string[] = ["test", "tests", "__tests__"];

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
  const basename = basenameOf(path);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot);
}

function isTestPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORY_SEGMENTS.includes(segment))) {
    return true;
  }
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(basenameOf(path));
}

function classifyNode(path: string): ScannedArtifact | undefined {
  const basename = basenameOf(path);
  if (basename === "package.json") return { path, kind: "manifest" };
  if (CONFIG_FILE_NAMES.includes(basename)) return { path, kind: "config" };
  const language = LANGUAGE_BY_EXTENSION[extensionOf(path)];
  if (language === undefined) return undefined;
  return { path, kind: isTestPath(path) ? "test" : "code", language };
}

/** Candidate source paths a test artifact verifies, in deterministic order. */
function testedSourceCandidates(testPath: string): readonly string[] {
  const segments = testPath.split("/");
  const basename = segments[segments.length - 1] as string;
  const stem = basename.replace(/\.(?:test|spec)(\.[cm]?[jt]sx?)$/u, "$1");
  const directories = segments.slice(0, -1);
  const candidates: string[] = [];
  const testSegment = directories.findIndex((segment) => TEST_DIRECTORY_SEGMENTS.includes(segment));
  if (testSegment !== -1) {
    const mirrored = [...directories];
    mirrored[testSegment] = "src";
    candidates.push([...mirrored, stem].join("/"));
  }
  candidates.push([...directories, stem].join("/"));
  return candidates;
}

function detections(root: string, markers: readonly string[]): readonly string[] {
  return markers.filter((marker) => existsSync(join(root, marker)));
}

/** Create the Node stack adapter bound to the canonical pack descriptor. */
export function createNodeStackAdapter(): StackAdapter {
  const detection = NODE_PACK.detection;
  if (detection === undefined) {
    throw new Error("node pack is missing its detection markers");
  }
  return {
    name: NODE_PACK.name,
    manifest: NODE_PACK_MANIFEST,
    detect(root: string): Promise<StackDetection | null> {
      const evidence = detections(root, detection.markers);
      if (evidence.length === 0) return Promise.resolve(null);
      return Promise.resolve({
        stack: "node",
        confidence: detection.confidence,
        evidence,
      });
    },
    scan(root: string): Promise<StackScan> {
      const artifacts = listRepositoryFiles(root)
        .map(classifyNode)
        .filter((artifact): artifact is ScannedArtifact => artifact !== undefined);
      const artifactPaths = new Set(artifacts.map((artifact) => artifact.path));
      const relations: ScannedRelation[] = [];
      for (const artifact of artifacts) {
        if (artifact.kind !== "test") continue;
        const target = testedSourceCandidates(artifact.path).find((candidate) =>
          artifactPaths.has(candidate),
        );
        if (target !== undefined) {
          relations.push({ from_path: artifact.path, to_path: target, kind: "tests" });
        }
      }
      relations.sort((left, right) =>
        left.from_path < right.from_path
          ? -1
          : left.from_path > right.from_path
            ? 1
            : left.to_path < right.to_path
              ? -1
              : left.to_path > right.to_path
                ? 1
                : 0,
      );
      return Promise.resolve({ artifacts, relations });
    },
    defaults() {
      return {
        pack: NODE_PACK.name,
        gates: NODE_PACK.gates.map((gate) => gate.gate_id),
        projection_views: NODE_PACK.projection_views,
      };
    },
  };
}
