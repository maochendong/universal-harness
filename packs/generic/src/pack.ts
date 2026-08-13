import { readFileSync } from "node:fs";

import { PROTOCOL_VERSION, type PluginManifest } from "@universal-harness-internal/core";
import {
  packDigest,
  parsePackDescriptorJson,
  type PackDescriptor,
  type StackAdapter,
  type StackDetection,
  type StackScan,
} from "@universal-harness-internal/plugin-sdk";

/**
 * Canonical Generic Pack (design 13.1/13.3, plan Task 25 step 1). The
 * descriptor in `pack.json` is the single source of truth: it carries the
 * approved M1 LoopPolicy ceilings as pack-layer policy fields and the neutral
 * provider instruction template. The digest pins the exact content a project
 * locks and upgrades against.
 */

/** Load and validate the canonical descriptor from disk. */
export function loadGenericPack(): PackDescriptor {
  return parsePackDescriptorJson(readFileSync(new URL("../pack.json", import.meta.url), "utf8"));
}

export const GENERIC_PACK: PackDescriptor = loadGenericPack();

export const GENERIC_PACK_DIGEST: string = packDigest(GENERIC_PACK);

export const GENERIC_PACK_MANIFEST: PluginManifest = {
  protocol_version: PROTOCOL_VERSION,
  record_kind: "plugin_manifest",
  name: GENERIC_PACK.name,
  version: GENERIC_PACK.version,
  kind: "stack",
  capabilities: ["stack.detect", "stack.scan"],
  resources: ["repository.read"],
};

/**
 * The generic stack adapter is the neutral fallback: it applies everywhere at
 * confidence 0, so any stack-specific adapter with positive confidence wins,
 * and it contributes no stack-specific scan claims.
 */
export function createGenericStackAdapter(): StackAdapter {
  return {
    name: GENERIC_PACK.name,
    manifest: GENERIC_PACK_MANIFEST,
    detect(): Promise<StackDetection | null> {
      return Promise.resolve({ stack: "generic", confidence: 0, evidence: [] });
    },
    scan(): Promise<StackScan> {
      return Promise.resolve({ artifacts: [], relations: [] });
    },
    defaults() {
      return {
        pack: GENERIC_PACK.name,
        gates: GENERIC_PACK.gates.map((gate) => gate.gate_id),
        projection_views: GENERIC_PACK.projection_views,
      };
    },
  };
}
