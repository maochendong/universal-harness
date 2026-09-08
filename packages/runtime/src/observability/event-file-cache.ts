import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { basename, join } from "node:path";
import {
  LedgerCorruptionError,
  readCommittedOperation,
  readCommittedEventShard,
  resolveHarnessPath,
  validateSchema,
  type CommittedOperation,
  type LifecycleEvent,
  type ObservationEvent,
} from "@universal-harness-internal/core";

interface LedgerFile {
  readonly stamp: Stats;
  readonly shardStamp: Stats;
  readonly operation: CommittedOperation;
  readonly events: readonly LifecycleEvent[];
}
interface LiveFile {
  readonly stamp: Stats;
  readonly tail: Buffer;
  readonly events: readonly ObservationEvent[];
}
export interface EventFileSnapshot {
  readonly ledger: readonly LifecycleEvent[];
  readonly live: readonly ObservationEvent[];
  readonly historyReplaced: boolean;
}
function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function stamp(path: string): Stats | undefined {
  try {
    const result = lstatSync(path);
    if (!result.isFile()) throw new LedgerCorruptionError("event source must be a regular file");
    return result;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function unchanged(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
function files(root: string, extension: string, recursive: boolean): string[] {
  const found: string[] = [];
  const visit = (path: string): void => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        throw new LedgerCorruptionError("symbolic event sources are not supported");
      const child = join(path, entry.name);
      if (entry.isDirectory() && recursive) visit(child);
      else if (entry.isFile() && entry.name.endsWith(extension)) found.push(child);
    }
  };
  visit(root);
  return found;
}

/** Metadata discovery is O(files); unchanged content is never reparsed. */
export class EventFileCache {
  private readonly ledger = new Map<string, LedgerFile>();
  private readonly live = new Map<string, LiveFile>();
  private initialized = false;
  constructor(private readonly harnessRoot: string) {}
  clear(): void {
    this.ledger.clear();
    this.live.clear();
    this.initialized = false;
  }

  refresh(): EventFileSnapshot | undefined {
    let changed = !this.initialized;
    let historyReplaced = false;
    const manifestFiles = new Set(
      files(join(this.harnessRoot, "ledger/operations"), ".json", false),
    );
    for (const path of this.ledger.keys()) {
      if (!manifestFiles.has(path)) {
        this.ledger.delete(path);
        changed = true;
        historyReplaced = true;
      }
    }
    for (const path of manifestFiles) {
      const current = stamp(path);
      if (current === undefined)
        throw new LedgerCorruptionError("committed manifest disappeared during read");
      const previous = this.ledger.get(path);
      const manifestChanged = previous === undefined || !unchanged(previous.stamp, current);
      const operation = manifestChanged
        ? readCommittedOperation(this.harnessRoot, basename(path))
        : previous.operation;
      const shard = stamp(resolveHarnessPath(this.harnessRoot, operation.manifest.event_file));
      if (shard === undefined) throw new LedgerCorruptionError("missing committed event shard");
      if (!manifestChanged && previous !== undefined && unchanged(previous.shardStamp, shard))
        continue;
      const events = readCommittedEventShard(this.harnessRoot, operation, {
        unknownEventTypes: "skip",
      });
      this.ledger.set(path, { stamp: current, shardStamp: shard, operation, events });
      changed = true;
      if (previous !== undefined) historyReplaced = true;
    }
    const liveFiles = new Set(files(join(this.harnessRoot, "cache/event-stream"), ".jsonl", true));
    for (const path of this.live.keys()) {
      if (!liveFiles.has(path)) {
        this.live.delete(path);
        changed = true;
      }
    }
    for (const path of liveFiles) {
      const current = stamp(path);
      if (current === undefined) {
        if (this.live.delete(path)) changed = true;
        continue;
      }
      const previous = this.live.get(path);
      if (previous !== undefined && unchanged(previous.stamp, current)) continue;
      const next = this.readLive(path, previous);
      if (next === undefined) this.live.delete(path);
      else this.live.set(path, next);
      changed = true;
    }
    this.initialized = true;
    if (!changed) return undefined;
    return {
      ledger: [...this.ledger.values()].flatMap((file) => file.events),
      live: [...this.live.values()].flatMap((file) => file.events),
      historyReplaced,
    };
  }

  private readLive(path: string, previous: LiveFile | undefined): LiveFile | undefined {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    try {
      const current = fstatSync(fd);
      const appended =
        previous !== undefined &&
        sameIdentity(previous.stamp, current) &&
        current.size > previous.stamp.size &&
        current.mtimeMs >= previous.stamp.mtimeMs &&
        current.ctimeMs >= previous.stamp.ctimeMs;
      const offset = appended ? previous.stamp.size : 0;
      const bytes = Buffer.alloc(current.size - offset);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(fd, bytes, length, bytes.length - length, offset + length);
        if (read === 0) break;
        length += read;
      }
      if (length !== bytes.length) return undefined;
      const content = appended ? Buffer.concat([previous.tail, bytes]) : bytes;
      const events = appended ? [...previous.events] : [];
      let start = 0;
      for (let end = content.indexOf(10, start); end !== -1; end = content.indexOf(10, start)) {
        const line = content.subarray(start, end).toString("utf8");
        start = end + 1;
        if (line.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (validateSchema("observation", parsed).valid) events.push(parsed as ObservationEvent);
        } catch {
          /* Bad complete live lines do not hide later complete lines. */
        }
      }
      return { stamp: current, tail: Buffer.from(content.subarray(start)), events };
    } finally {
      closeSync(fd);
    }
  }
}
