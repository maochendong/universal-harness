import { readFileSync } from "node:fs";

import { PROTOCOL_VERSION, type PluginManifest } from "@universal-harness-internal/core";
import {
  packDigest,
  parsePackDescriptorJson,
  type PackDescriptor,
} from "@universal-harness-internal/plugin-sdk";

/**
 * Canonical Java Pack (design 13.1, plan Task 25). The descriptor in
 * `pack.json` is the single source of truth: detection markers, stack-profile
 * gates, policy fields and the provider instruction template. The digest pins
 * the exact content a project locks and upgrades against.
 */

/** Load and validate the canonical descriptor from disk. */
export function loadJavaPack(): PackDescriptor {
  return parsePackDescriptorJson(readFileSync(new URL("../pack.json", import.meta.url), "utf8"));
}

export const JAVA_PACK: PackDescriptor = loadJavaPack();

export const JAVA_PACK_DIGEST: string = packDigest(JAVA_PACK);

export const JAVA_PACK_MANIFEST: PluginManifest = {
  protocol_version: PROTOCOL_VERSION,
  record_kind: "plugin_manifest",
  name: JAVA_PACK.name,
  version: JAVA_PACK.version,
  kind: "stack",
  capabilities: ["stack.detect", "stack.scan"],
  resources: ["repository.read"],
};
