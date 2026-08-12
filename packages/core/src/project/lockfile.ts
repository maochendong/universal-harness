import { canonicalizeJson } from "../identity/canonical-json.js";

/**
 * Pack lock at `.harness/harness.lock`. Every upstream pack is pinned to an
 * exact semantic version and the SHA-256 digest of its canonical content, so
 * pack resolution is reproducible offline and upgrades are explicit,
 * previewable operations instead of silent drift. The lock is authoritative
 * data committed to Git and serializes to canonical JSON.
 */
export const PACK_LOCK_VERSION = 1 as const;

export class PackLockError extends Error {
  readonly kind = "pack_lock_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "PackLockError";
  }
}

export interface LockedPack {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

export interface PackLock {
  readonly lock_version: number;
  /** Sorted by pack name; duplicate names are rejected. */
  readonly packs: readonly LockedPack[];
}

const PACK_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/u;
const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

export function assertLockedPack(pack: LockedPack): void {
  if (!PACK_NAME_PATTERN.test(pack.name)) {
    throw new PackLockError(`invalid pack name: ${JSON.stringify(pack.name)}`);
  }
  if (!SEMANTIC_VERSION_PATTERN.test(pack.version)) {
    throw new PackLockError(
      `pack ${pack.name} is not pinned to an exact semantic version: ${JSON.stringify(pack.version)}`,
    );
  }
  if (!SHA256_HEX_PATTERN.test(pack.digest)) {
    throw new PackLockError(`pack ${pack.name} digest is not a SHA-256 hex string`);
  }
}

export function createPackLock(packs: readonly LockedPack[]): PackLock {
  const sorted = [...packs].sort((left, right) => (left.name < right.name ? -1 : 1));
  const seen = new Set<string>();
  for (const pack of sorted) {
    assertLockedPack(pack);
    if (seen.has(pack.name)) {
      throw new PackLockError(`duplicate pack in lock: ${pack.name}`);
    }
    seen.add(pack.name);
  }
  return { lock_version: PACK_LOCK_VERSION, packs: sorted };
}

export function serializePackLock(lock: PackLock): string {
  return `${canonicalizeJson(createPackLock(lock.packs))}\n`;
}

export function parsePackLock(raw: string): PackLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PackLockError("pack lock is not valid canonical JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PackLockError("pack lock must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record["lock_version"] !== PACK_LOCK_VERSION) {
    throw new PackLockError(`unsupported lock_version: ${JSON.stringify(record["lock_version"])}`);
  }
  const packs = record["packs"];
  if (!Array.isArray(packs)) {
    throw new PackLockError("pack lock field packs must be an array");
  }
  const locked: LockedPack[] = packs.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new PackLockError("locked pack entries must be JSON objects");
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate["name"] !== "string" ||
      typeof candidate["version"] !== "string" ||
      typeof candidate["digest"] !== "string"
    ) {
      throw new PackLockError("locked pack entries need string name, version and digest");
    }
    return {
      name: candidate["name"],
      version: candidate["version"],
      digest: candidate["digest"],
    };
  });
  return createPackLock(locked);
}
