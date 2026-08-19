import { isSafeRelativeLocator } from "./policy.js";
import { collectContextSources, type ContextFileAccessor } from "./collect.js";
import type { ProjectContextPort, ProjectContextRequest, ProjectContextResult } from "./port.js";
import { createProjectContextBundleRecord, ProjectContextError } from "./records.js";
import { acceptProjectContextBundle } from "./validate.js";

/**
 * InMemoryProjectContextAdapter (intent-to-prd design 8.3): the test adapter.
 * It has no filesystem handle at all — the only bytes it can see are the
 * constructor-provided map — which is what makes the "no project file or
 * ledger access" property structural instead of a promise.
 */
export type InMemoryContextFile = string | Uint8Array | { readonly symlink_to: string };

export function createInMemoryProjectContextAdapter(options: {
  readonly files: Readonly<Record<string, InMemoryContextFile>>;
  /** Locators the fake "repository" tracks; defaults to every safe locator in the map. */
  readonly tracked?: readonly string[];
}): ProjectContextPort {
  const files = options.files;
  const tracked =
    options.tracked === undefined
      ? undefined
      : new Set(options.tracked.filter((locator) => isSafeRelativeLocator(locator)));

  const accessor: ContextFileAccessor = {
    probe(locator) {
      const entry = files[locator];
      if (entry === undefined) {
        return { exists: false, symlinkEscaped: false, tracked: false, size: 0 };
      }
      if (typeof entry === "object" && !(entry instanceof Uint8Array) && "symlink_to" in entry) {
        const target = entry.symlink_to;
        const escaped =
          !isSafeRelativeLocator(target) || target.startsWith("/") || target.includes("..");
        return { exists: true, symlinkEscaped: escaped, tracked: true, size: 0 };
      }
      const bytes =
        typeof entry === "string" ? new TextEncoder().encode(entry) : (entry as Uint8Array);
      return {
        exists: true,
        symlinkEscaped: false,
        tracked: tracked === undefined ? true : tracked.has(locator),
        size: bytes.byteLength,
      };
    },
    read(locator) {
      const entry = files[locator];
      if (typeof entry === "string") return new TextEncoder().encode(entry);
      if (entry instanceof Uint8Array) return entry;
      throw new Error(`locator is not a readable file: ${locator}`);
    },
  };

  return {
    name: "in-memory",
    compile(request: ProjectContextRequest): ProjectContextResult {
      try {
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
