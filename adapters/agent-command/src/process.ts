import {
  PluginSubprocessError,
  runPluginSubprocess,
  type PluginSubprocessOptions,
  type PluginSubprocessResult,
} from "@universal-harness-internal/plugin-sdk";

/**
 * Provider process execution (design 13.2, 16). The provider runs as one
 * delegated child process through the Plugin SDK subprocess runner: fixed
 * executable plus an argument array, scrubbed environment, timeout kill and
 * capped output capture -- no user or model text ever reaches a shell. This
 * is process supervision, not an OS containment boundary.
 *
 * The names below are the adapter-local aliases of the SDK contract, kept so
 * existing call sites and tests read in provider terms.
 */

export type ProcessRunOptions = PluginSubprocessOptions;

export type ProcessRunResult = PluginSubprocessResult;

/** The executable could not be started at all (e.g. ENOENT). */
export const ProcessSpawnError = PluginSubprocessError;

export type ProcessSpawnError = PluginSubprocessError;

export const runCommandProcess = runPluginSubprocess;
