import { canonicalizeLocator } from "./locator.js";

/**
 * Rescan classification for scanned nodes. A pure rename changes only the
 * locator while the normalized content digest stays identical; anything that
 * also changes content, public surface or bindings is treated as a change
 * seed of its own so a rename alone never triggers downstream churn.
 */
export type RescanClassification =
  "unchanged" | "pure-rename" | "content-change" | "rename-with-change";

export interface NodeSnapshot {
  locator: string;
  digest: string;
}

export function classifyRescan(previous: NodeSnapshot, next: NodeSnapshot): RescanClassification {
  const sameLocator = canonicalizeLocator(previous.locator) === canonicalizeLocator(next.locator);
  const sameDigest = previous.digest === next.digest;
  if (sameLocator && sameDigest) return "unchanged";
  if (sameLocator) return "content-change";
  if (sameDigest) return "pure-rename";
  return "rename-with-change";
}

export class RenameChainError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid rename chain: ${reason}`);
    this.name = "RenameChainError";
    this.reason = reason;
  }
}

/**
 * One SUPERSEDES provenance step: the node with `superseding_id` replaces the
 * node with `superseded_id`. Chains are append-only at the head, which makes
 * them stable, acyclic and orphan-free by construction.
 */
export interface SupersedesLink {
  superseding_id: string;
  superseded_id: string;
}

export function appendSupersedesLink(
  chain: readonly SupersedesLink[],
  link: SupersedesLink,
): SupersedesLink[] {
  if (link.superseding_id === link.superseded_id) {
    throw new RenameChainError(`self-supersede is not allowed: ${link.superseding_id}`);
  }
  for (const existing of chain) {
    if (existing.superseding_id === link.superseding_id) {
      throw new RenameChainError(
        `identity already supersedes another node: ${link.superseding_id}`,
      );
    }
    if (existing.superseded_id === link.superseding_id) {
      throw new RenameChainError(
        `identity is already superseded and must not be reused: ${link.superseding_id}`,
      );
    }
  }
  const head = chainHead(chain);
  if (head !== undefined && link.superseded_id !== head) {
    throw new RenameChainError(
      `link supersedes ${link.superseded_id} instead of the chain head ${head}`,
    );
  }
  return [...chain, link];
}

/** The newest (live) node ID of the chain, or undefined for an empty chain. */
export function chainHead(chain: readonly SupersedesLink[]): string | undefined {
  return chain.length === 0 ? undefined : chain[chain.length - 1]?.superseding_id;
}

/** Every node ID in the chain, oldest first. */
export function chainNodeIds(chain: readonly SupersedesLink[]): string[] {
  const first = chain[0];
  if (first === undefined) return [];
  return [first.superseded_id, ...chain.map((link) => link.superseding_id)];
}
