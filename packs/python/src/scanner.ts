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

import { PYTHON_PACK, PYTHON_PACK_MANIFEST } from "./pack.js";

/**
 * Python StackAdapter (design 13.1, plan Task 25 step 2). Detection is marker
 * based and scanning is pure file-system observation. Test relations are
 * deterministic path rules only (`tests/test_foo.py` tests `src/foo.py` or a
 * sibling `foo.py`), never inferred semantics.
 */

const MANIFEST_FILE_NAMES: readonly string[] = ["pyproject.toml", "setup.py"];
const CONFIG_FILE_NAMES: readonly string[] = ["requirements.txt", "setup.cfg"];

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isTestPath(path: string): boolean {
  const basename = basenameOf(path);
  return (
    path.split("/").slice(0, -1).includes("tests") ||
    /^test_.*\.py$/u.test(basename) ||
    /_test\.py$/u.test(basename)
  );
}

function classifyPython(path: string): ScannedArtifact | undefined {
  const basename = basenameOf(path);
  if (MANIFEST_FILE_NAMES.includes(basename)) return { path, kind: "manifest" };
  if (CONFIG_FILE_NAMES.includes(basename)) return { path, kind: "config" };
  if (!path.endsWith(".py")) return undefined;
  return { path, kind: isTestPath(path) ? "test" : "code", language: "python" };
}

/** Candidate source paths a test artifact verifies, in deterministic order. */
function testedSourceCandidates(testPath: string): readonly string[] {
  const segments = testPath.split("/");
  const basename = segments[segments.length - 1] as string;
  const stem = basename.startsWith("test_")
    ? basename.slice("test_".length)
    : basename.replace(/_test\.py$/u, ".py");
  const directories = segments.slice(0, -1);
  const candidates: string[] = [];
  const testsIndex = directories.indexOf("tests");
  if (testsIndex !== -1) {
    const mirrored = [...directories];
    mirrored[testsIndex] = "src";
    candidates.push([...mirrored, stem].join("/"));
  }
  candidates.push([...directories, stem].join("/"));
  return candidates;
}

/** Create the Python stack adapter bound to the canonical pack descriptor. */
export function createPythonStackAdapter(): StackAdapter {
  const detection = PYTHON_PACK.detection;
  if (detection === undefined) {
    throw new Error("python pack is missing its detection markers");
  }
  return {
    name: PYTHON_PACK.name,
    manifest: PYTHON_PACK_MANIFEST,
    detect(root: string): Promise<StackDetection | null> {
      const evidence = detection.markers.filter((marker) => existsSync(join(root, marker)));
      if (evidence.length === 0) return Promise.resolve(null);
      return Promise.resolve({
        stack: "python",
        confidence: detection.confidence,
        evidence,
      });
    },
    scan(root: string): Promise<StackScan> {
      const artifacts = listRepositoryFiles(root)
        .map(classifyPython)
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
        pack: PYTHON_PACK.name,
        gates: PYTHON_PACK.gates.map((gate) => gate.gate_id),
        projection_views: PYTHON_PACK.projection_views,
      };
    },
  };
}
