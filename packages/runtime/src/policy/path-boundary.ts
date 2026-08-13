import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { normalizeLocatorPath } from "@universal-harness-internal/core";

import { PolicyError } from "./action.js";

/**
 * Read/write path scope and the symlink-aware repository boundary (design 14;
 * plan task 15 step 3). Lexical normalization rejects traversal before any
 * decision; the filesystem check then resolves every existing ancestor
 * through realpath so a symlink inside the repository can never be used to
 * read or write outside it. Paths that do not exist yet are checked against
 * their nearest existing ancestor.
 */
export function normalizeRepoRelativePath(input: string): string {
  try {
    return normalizeLocatorPath(input);
  } catch (error) {
    throw new PolicyError(
      "boundary_violation",
      `path ${input} is not a legal repository-relative path: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Like normalizeRepoRelativePath, but returns undefined instead of throwing. */
export function tryNormalizeRepoRelativePath(input: string): string | undefined {
  try {
    return normalizeRepoRelativePath(input);
  } catch {
    return undefined;
  }
}

/**
 * Whether a repository-relative path falls inside one of the declared scope
 * prefixes. A scope covers itself and everything below it; a path that fails
 * lexical normalization is never within scope.
 */
export function isPathWithinScopes(scopes: readonly string[], path: string): boolean {
  const target = tryNormalizeRepoRelativePath(path);
  if (target === undefined) return false;
  return scopes.some((scope) => {
    const normalizedScope = tryNormalizeRepoRelativePath(scope);
    return (
      normalizedScope !== undefined &&
      (target === normalizedScope || target.startsWith(`${normalizedScope}/`))
    );
  });
}

/**
 * Resolve a declared repository-relative path to its absolute form, proving
 * it cannot escape the repository through symlinks. The repository root is
 * resolved first; every existing ancestor of the candidate is then resolved
 * through realpath and must stay inside the resolved root. Returns the
 * absolute candidate path on success and throws a typed boundary_violation
 * otherwise.
 */
export function assertWithinRepositoryBoundary(
  repositoryRoot: string,
  candidatePath: string,
): string {
  const relative = normalizeRepoRelativePath(candidatePath);
  let rootReal: string;
  try {
    rootReal = realpathSync(repositoryRoot);
  } catch {
    throw new PolicyError(
      "boundary_violation",
      `repository root ${repositoryRoot} cannot be resolved`,
    );
  }
  const candidateAbsolute = resolve(rootReal, relative);
  let probe = candidateAbsolute;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) {
      throw new PolicyError(
        "boundary_violation",
        `no existing ancestor for ${candidatePath} under ${repositoryRoot}`,
      );
    }
    probe = parent;
  }
  const probeReal = realpathSync(probe);
  if (probeReal !== rootReal && !probeReal.startsWith(`${rootReal}${sep}`)) {
    throw new PolicyError(
      "boundary_violation",
      `path ${candidatePath} escapes the repository boundary through a symlink ` +
        `(resolves to ${probeReal})`,
      { candidate: candidatePath, resolved: probeReal, root: rootReal },
    );
  }
  return candidateAbsolute;
}
