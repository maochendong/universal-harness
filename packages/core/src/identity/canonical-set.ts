import { contentDigest } from "./digest.js";

/**
 * Canonical ordering for string sets (capability ids, slot names, digests)
 * before they enter a semantic digest. Members are Unicode-normalized to NFC,
 * deduplicated, and sorted by UTF-16 code unit — the same comparator
 * `canonicalizeJson` uses for object keys — so any input permutation of the
 * same set digests identically while any semantic change to membership
 * changes the digest.
 */
export class CanonicalSetError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Cannot canonicalize set: ${reason}`);
    this.name = "CanonicalSetError";
    this.reason = reason;
  }
}

export function canonicalStringSet(values: readonly string[]): string[] {
  const normalized = values.map((value) => {
    if (typeof value !== "string") {
      throw new CanonicalSetError(`canonical set members must be strings, got ${typeof value}`);
    }
    return value.normalize("NFC");
  });
  return [...new Set(normalized)].sort();
}

export function canonicalSetDigest(values: readonly string[]): string {
  return contentDigest(canonicalStringSet(values));
}
