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

import { JAVA_PACK, JAVA_PACK_MANIFEST } from "./pack.js";

/**
 * Java StackAdapter (design 13.1, plan Task 25 step 2). Detection is marker
 * based and scanning is pure file-system observation. Test relations follow
 * the standard Maven/Gradle layout only: `src/test/java/.../FooTest.java`
 * tests `src/main/java/.../Foo.java`; nothing is inferred semantically.
 */

const MANIFEST_FILE_NAMES: readonly string[] = ["pom.xml"];
const CONFIG_FILE_NAMES: readonly string[] = [
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
];

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isTestPath(path: string): boolean {
  return path.includes("src/test/") || /Tests?\.java$/u.test(basenameOf(path));
}

function classifyJava(path: string): ScannedArtifact | undefined {
  const basename = basenameOf(path);
  if (MANIFEST_FILE_NAMES.includes(basename)) return { path, kind: "manifest" };
  if (CONFIG_FILE_NAMES.includes(basename)) return { path, kind: "config" };
  if (!path.endsWith(".java")) return undefined;
  return { path, kind: isTestPath(path) ? "test" : "code", language: "java" };
}

/** Source path a test artifact verifies under the standard layout. */
function testedSourcePath(testPath: string): string {
  const stem = basenameOf(testPath).replace(/Tests?\.java$/u, ".java");
  const directories = testPath.split("/").slice(0, -1);
  const testIndex = directories.findIndex(
    (segment, index) => segment === "test" && directories[index - 1] === "src",
  );
  const mirrored = [...directories];
  if (testIndex !== -1) {
    mirrored[testIndex] = "main";
  }
  return [...mirrored, stem].join("/");
}

/** Create the Java stack adapter bound to the canonical pack descriptor. */
export function createJavaStackAdapter(): StackAdapter {
  const detection = JAVA_PACK.detection;
  if (detection === undefined) {
    throw new Error("java pack is missing its detection markers");
  }
  return {
    name: JAVA_PACK.name,
    manifest: JAVA_PACK_MANIFEST,
    detect(root: string): Promise<StackDetection | null> {
      const evidence = detection.markers.filter((marker) => existsSync(join(root, marker)));
      if (evidence.length === 0) return Promise.resolve(null);
      return Promise.resolve({
        stack: "java",
        confidence: detection.confidence,
        evidence,
      });
    },
    scan(root: string): Promise<StackScan> {
      const artifacts = listRepositoryFiles(root)
        .map(classifyJava)
        .filter((artifact): artifact is ScannedArtifact => artifact !== undefined);
      const artifactPaths = new Set(artifacts.map((artifact) => artifact.path));
      const relations: ScannedRelation[] = [];
      for (const artifact of artifacts) {
        if (artifact.kind !== "test") continue;
        const target = testedSourcePath(artifact.path);
        if (artifactPaths.has(target)) {
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
        pack: JAVA_PACK.name,
        gates: JAVA_PACK.gates.map((gate) => gate.gate_id),
        projection_views: JAVA_PACK.projection_views,
      };
    },
  };
}
