import { createPackLock, type LockedPack, type PackLock } from "@universal-harness-internal/core";
import { packDigest, type PackDescriptor } from "@universal-harness-internal/plugin-sdk";

import { PackError } from "./resolver.js";

/**
 * Pack lockfile helpers (design section 5, plan Task 25 step 4). The core
 * `PackLock` owns parsing and serialization; this module binds lock entries
 * to canonical pack descriptors, so an upgrade can prove the locked digest
 * still matches the installed upstream snapshot before it touches anything.
 */

/** Lock entry for a canonical descriptor: exact version plus content digest. */
export function lockEntryForPack(descriptor: PackDescriptor): LockedPack {
  return { name: descriptor.name, version: descriptor.version, digest: packDigest(descriptor) };
}

/** The lock entry for a pack name, or undefined when the pack is not locked. */
export function lockedPackEntry(lock: PackLock, name: string): LockedPack | undefined {
  return lock.packs.find((pack) => pack.name === name);
}

/** Insert or replace the entry for `entry.name`; the result stays sorted. */
export function upsertLockedPack(lock: PackLock, entry: LockedPack): PackLock {
  return createPackLock([...lock.packs.filter((pack) => pack.name !== entry.name), entry]);
}

/**
 * Verify the lock pins exactly this descriptor: the pack must be locked at
 * the same version and content digest. Any divergence is a typed
 * `digest_mismatch`, never a silent re-pin.
 */
export function assertLockMatchesPack(lock: PackLock, descriptor: PackDescriptor): void {
  const entry = lockedPackEntry(lock, descriptor.name);
  if (entry === undefined) {
    throw new PackError("pack_not_found", `pack ${descriptor.name} is not present in the lockfile`);
  }
  const expected = lockEntryForPack(descriptor);
  if (entry.version !== expected.version || entry.digest !== expected.digest) {
    throw new PackError(
      "digest_mismatch",
      `pack ${descriptor.name} is locked at ${entry.version} (${entry.digest}) but the ` +
        `descriptor resolves to ${expected.version} (${expected.digest})`,
      { locked: entry, resolved: expected },
    );
  }
}
