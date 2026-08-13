import type { PluginManifest } from "@universal-harness-internal/core";

/**
 * StackAdapter port (design 13.1). A stack adapter detects the technology
 * stack of a repository with a confidence score, scans code artifacts, tests
 * and deterministic relations, and names its default pack, gates and
 * projection views. The port is pure description: detection and scanning
 * never mutate the repository, and every claim carries the evidence it was
 * derived from so the Harness can audit why a stack was chosen.
 */

export interface StackDetection {
  /** Stable stack identifier, e.g. `node`, `python`, `java` or `generic`. */
  readonly stack: string;
  /** Detection confidence in [0, 1]; the Harness picks the highest. */
  readonly confidence: number;
  /** Repository-relative evidence paths the detection is derived from. */
  readonly evidence: readonly string[];
}

export const STACK_ARTIFACT_KINDS = ["code", "test", "config", "manifest"] as const;

export type StackArtifactKind = (typeof STACK_ARTIFACT_KINDS)[number];

export interface ScannedArtifact {
  /** Repository-relative path. */
  readonly path: string;
  readonly kind: StackArtifactKind;
  /** Language tag for code/test artifacts, e.g. `typescript`. */
  readonly language?: string;
}

/**
 * A deterministic relation between two scanned artifacts, e.g. `imports` or
 * `tests`. Only relations derivable without executing the project belong here.
 */
export interface ScannedRelation {
  readonly from_path: string;
  readonly to_path: string;
  readonly kind: string;
}

export interface StackScan {
  readonly artifacts: readonly ScannedArtifact[];
  readonly relations: readonly ScannedRelation[];
}

/** Defaults the stack contributes when a project adopts it. */
export interface StackDefaults {
  /** Canonical pack name, e.g. `@universal-harness-internal/pack-node`. */
  readonly pack: string;
  /** Stack profile gate identifiers (design 13.6 layer `stack`). */
  readonly gates: readonly string[];
  /** Projection views the stack renders by default. */
  readonly projection_views: readonly string[];
}

export interface StackAdapter {
  readonly name: string;
  readonly manifest: PluginManifest;
  /** Detect the stack at `root`, or return `null` when it does not apply. */
  detect(root: string): Promise<StackDetection | null>;
  /** Scan artifacts, tests and deterministic relations without mutating anything. */
  scan(root: string): Promise<StackScan>;
  defaults(): StackDefaults;
}
