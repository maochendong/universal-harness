import { isAbsolute, resolve, sep } from "node:path";

/**
 * Canonical on-disk layout of the Git-native ledger. All ledger-relative
 * paths use POSIX separators so committed manifests are identical across
 * platforms; `resolveHarnessPath` is the single choke point that maps them
 * onto the host file system and refuses any escape from `.harness`.
 */
export const HARNESS_DIRECTORY = ".harness";
export const WRITE_LOCK_RELATIVE_PATH = "locks/write.lock";

export class LedgerPathError extends Error {
  readonly kind = "ledger_path_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "LedgerPathError";
  }
}

const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*_[A-Za-z0-9_-]+$/u;
const SHARD_MONTH_PATTERN = /^[0-9]{4}-[0-9]{2}$/u;

export function harnessRootFor(projectRoot: string): string {
  return resolve(projectRoot, HARNESS_DIRECTORY);
}

export function assertLedgerOperationId(operationId: string): void {
  if (
    !OPERATION_ID_PATTERN.test(operationId) ||
    operationId.includes("/") ||
    operationId.includes("\\") ||
    operationId.includes("..")
  ) {
    throw new LedgerPathError(
      `invalid ledger_operation_id for ledger paths: ${JSON.stringify(operationId)}`,
    );
  }
}

export function assertShardMonth(month: string): void {
  if (!SHARD_MONTH_PATTERN.test(month)) {
    throw new LedgerPathError(`invalid shard month: ${JSON.stringify(month)}`);
  }
}

/** Derive the `YYYY-MM` shard from an ISO 8601 date-time (UTC calendar month). */
export function shardMonthFor(timestamp: string): string {
  const match = /^([0-9]{4})-([0-9]{2})-[0-9]{2}T/u.exec(timestamp);
  const year = match?.[1];
  const month = match?.[2];
  if (year === undefined || month === undefined) {
    throw new LedgerPathError(`cannot derive shard month from: ${JSON.stringify(timestamp)}`);
  }
  return `${year}-${month}`;
}

export function edgeShardRelativePath(month: string, operationId: string): string {
  assertShardMonth(month);
  assertLedgerOperationId(operationId);
  return `ledger/edges/${month}/${operationId}.jsonl`;
}

export function eventShardRelativePath(month: string, operationId: string): string {
  assertShardMonth(month);
  assertLedgerOperationId(operationId);
  return `events/${month}/${operationId}.jsonl`;
}

export function operationManifestRelativePath(operationId: string): string {
  assertLedgerOperationId(operationId);
  return `ledger/operations/${operationId}.json`;
}

export function stagingRelativePath(operationId: string): string {
  assertLedgerOperationId(operationId);
  return `staging/${operationId}`;
}

/**
 * Resolve a ledger-relative POSIX path inside the harness root, refusing
 * absolute paths, traversal segments and NUL bytes so a ledger record can
 * never address a file outside `.harness`.
 */
export function resolveHarnessPath(harnessRoot: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes(String.fromCharCode(0)) ||
    relativePath.includes("\\") ||
    isAbsolute(relativePath)
  ) {
    throw new LedgerPathError(`illegal ledger-relative path: ${JSON.stringify(relativePath)}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new LedgerPathError(`illegal ledger-relative path: ${JSON.stringify(relativePath)}`);
  }
  const resolved = resolve(harnessRoot, ...segments);
  const rootWithSeparator = harnessRoot.endsWith(sep) ? harnessRoot : `${harnessRoot}${sep}`;
  if (resolved !== harnessRoot && !resolved.startsWith(rootWithSeparator)) {
    throw new LedgerPathError(`path escapes harness root: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}
