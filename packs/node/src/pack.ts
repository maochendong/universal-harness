import { readFileSync } from "node:fs";

import { PROTOCOL_VERSION, type PluginManifest } from "@universal-harness-internal/core";
import {
  packDigest,
  parsePackDescriptorJson,
  type PackDescriptor,
} from "@universal-harness-internal/plugin-sdk";

/**
 * Canonical Node Pack (design 13.1, plan Task 25). The descriptor in
 * `pack.json` is the single source of truth: detection markers, stack-profile
 * gates, policy fields and the provider instruction template. The digest pins
 * the exact content a project locks and upgrades against.
 */

/** Load and validate the canonical descriptor from disk. */
export function loadNodePack(): PackDescriptor {
  return parsePackDescriptorJson(readFileSync(new URL("../pack.json", import.meta.url), "utf8"));
}

export const NODE_PACK: PackDescriptor = loadNodePack();

export const NODE_PACK_DIGEST: string = packDigest(NODE_PACK);

export const NODE_PACK_MANIFEST: PluginManifest = {
  protocol_version: PROTOCOL_VERSION,
  record_kind: "plugin_manifest",
  name: NODE_PACK.name,
  version: NODE_PACK.version,
  kind: "stack",
  capabilities: ["stack.detect", "stack.scan"],
  resources: ["repository.read"],
};
