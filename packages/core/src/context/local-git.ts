import { execFileSync } from "node:child_process";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import { collectContextSources, type ContextFileAccessor } from "./collect.js";
import type { ProjectContextPort, ProjectContextRequest, ProjectContextResult } from "./port.js";
import { createProjectContextBundleRecord, ProjectContextError } from "./records.js";
import { acceptProjectContextBundle } from "./validate.js";

/**
 * LocalGitProjectContextAdapter (intent-to-prd design 8.3): the adopt/iterate
 * adapter. It reads only the fixed candidate paths inside the project work
 * tree, skips anything git does not track, resolves every realpath to catch
 * symlink escapes, and never touches `.git` or `.harness` — the ledger is
 * summarized by trusted readers, never read raw.
 */
function trackedLocators(projectRoot: string): ReadonlySet<string> | undefined {
  try {
    const output = execFileSync("git", ["-C", projectRoot, "ls-files", "-z"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      output
        .toString("utf8")
        .split("\u0000")
        .filter((entry) => entry.length > 0),
    );
  } catch {
    // Not a git work tree (or git missing): fall back to presence-only
    // selection; the caller decides whether that is acceptable.
    return undefined;
  }
}

function createFsAccessor(projectRoot: string): ContextFileAccessor {
  const rootReal = realpathSync(projectRoot);
  const tracked = trackedLocators(projectRoot);
  return {
    probe(locator) {
      const absolute = resolve(projectRoot, locator);
      let stats;
      let resolved: string;
      try {
        resolved = realpathSync(absolute);
        stats = statSync(resolved);
      } catch {
        return { exists: false, symlinkEscaped: false, tracked: false, size: 0 };
      }
      const rootPrefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
      const symlinkEscaped = resolved !== rootReal && !resolved.startsWith(rootPrefix);
      return {
        exists: stats.isFile(),
        symlinkEscaped,
        tracked: tracked === undefined ? true : tracked.has(locator),
        size: stats.size,
      };
    },
    read(locator) {
      return readFileSync(resolve(projectRoot, locator));
    },
  };
}

export function createLocalGitProjectContextAdapter(options: {
  readonly projectRoot: string;
}): ProjectContextPort {
  return {
    name: "local-git",
    compile(request: ProjectContextRequest): ProjectContextResult {
      try {
        const accessor = createFsAccessor(options.projectRoot);
        const { sources, exclusions } = collectContextSources(accessor, request);
        const bundle = createProjectContextBundleRecord({
          session_id: request.session_id,
          purpose: request.purpose,
          project_baseline_digest: request.project_baseline_digest,
          profile_digest: request.project_profile_digest,
          policy_digest: request.capture_policy_digest,
          budget: request.budget,
          sources,
          exclusions,
        });
        // Defense in depth: the adapter re-runs the Harness acceptance gate on
        // its own output so a pipeline bug fails at the source.
        const acceptance = acceptProjectContextBundle(request, bundle);
        if (acceptance.status !== "accepted") {
          return {
            status: "blocked",
            failure: {
              code: "bundle_rejected",
              summary: `compiled bundle failed acceptance: ${acceptance.message}`,
              retryable: false,
            },
          };
        }
        return { status: "compiled", bundle };
      } catch (error) {
        if (error instanceof ProjectContextError) {
          return {
            status: "blocked",
            failure: { code: "invalid_request", summary: error.message, retryable: false },
          };
        }
        return {
          status: "blocked",
          failure: {
            code: "adapter_error",
            summary: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        };
      }
    },
  };
}
