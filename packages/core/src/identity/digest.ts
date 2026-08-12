import { createHash } from "node:crypto";

import { canonicalizeJson } from "./canonical-json.js";

/**
 * SHA-256 over the canonical JSON form of a value. Pure renames and other
 * locator-only changes never alter this digest, so it doubles as the rename
 * detection signal for scanned nodes.
 */
export function contentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}
