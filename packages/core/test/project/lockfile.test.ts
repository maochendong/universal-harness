import { describe, expect, it } from "vitest";

import {
  PACK_LOCK_VERSION,
  PackLockError,
  createPackLock,
  parsePackLock,
  serializePackLock,
} from "../../src/project/lockfile.js";

const digest = "a".repeat(64);

describe("pack lock", () => {
  it("sorts packs by name and round-trips deterministically", () => {
    const lock = createPackLock([
      { name: "pack-node", version: "1.2.0", digest },
      { name: "@universal-harness/pack-generic", version: "0.1.0", digest: "b".repeat(64) },
    ]);
    expect(lock.lock_version).toBe(PACK_LOCK_VERSION);
    expect(lock.packs.map((pack) => pack.name)).toEqual([
      "@universal-harness/pack-generic",
      "pack-node",
    ]);
    const serialized = serializePackLock(lock);
    expect(parsePackLock(serialized)).toEqual(lock);
    expect(serializePackLock(parsePackLock(serialized))).toBe(serialized);
  });

  it("rejects unpinned versions, bad digests and duplicates", () => {
    expect(() => createPackLock([{ name: "pack-node", version: "^1.2.0", digest }])).toThrow(
      PackLockError,
    );
    expect(() => createPackLock([{ name: "pack-node", version: "1.2.0", digest: "xyz" }])).toThrow(
      PackLockError,
    );
    expect(() =>
      createPackLock([
        { name: "pack-node", version: "1.2.0", digest },
        { name: "pack-node", version: "1.3.0", digest },
      ]),
    ).toThrow(PackLockError);
  });

  it("rejects malformed lock content", () => {
    expect(() => parsePackLock("not json")).toThrow(PackLockError);
    expect(() => parsePackLock('{"lock_version":2,"packs":[]}')).toThrow(PackLockError);
    expect(() => parsePackLock('{"lock_version":1,"packs":{"name":"x"}}')).toThrow(PackLockError);
    expect(() =>
      parsePackLock('{"lock_version":1,"packs":[{"name":"pack-node","version":"1.2.0"}]}'),
    ).toThrow(PackLockError);
  });
});
