import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPackLock,
  readManagedPackLock,
  serializePackLock,
} from "@universal-harness-internal/core";
import {
  packDigest,
  type PackDescriptor,
  type PackPolicyField,
} from "@universal-harness-internal/plugin-sdk";

import {
  PackError,
  applyPackUpgrade,
  installUpstreamPack,
  lockEntryForPack,
  previewPackUpgrade,
  readProjectPackOverride,
  readUpstreamPack,
  writeProjectPackOverride,
  type PackMigrationRegistry,
  type PackUpgradeRecord,
} from "../../src/index.js";
import { field, layer } from "../policy/fixtures.js";
import { PACK_NAME, cleanupTempProjects, makePackDescriptor, makeTempProject } from "./fixtures.js";

afterEach(cleanupTempProjects);

const APPROVAL = "a".repeat(64);
const HEX_DIGEST = /^[a-f0-9]{64}$/u;

/** Install pack v1 plus its lock; returns the harness root and lock. */
function installV1(policies?: readonly PackPolicyField[]) {
  const { harnessRoot, projectRoot } = makeTempProject();
  const v1 = makePackDescriptor(policies === undefined ? {} : { policies });
  installUpstreamPack(harnessRoot, v1);
  const lock = createPackLock([lockEntryForPack(v1)]);
  writeFileSync(join(harnessRoot, "harness.lock"), serializePackLock(lock), "utf8");
  return { harnessRoot, projectRoot, v1, lock };
}

function v2(overrides: Parameters<typeof makePackDescriptor>[0] = {}): PackDescriptor {
  return makePackDescriptor({ version: "2.0.0", ...overrides });
}

describe("previewPackUpgrade", () => {
  it("is deterministic and reports policy, gate and template changes", () => {
    const { harnessRoot, lock } = installV1();
    const next = v2({
      policies: [
        { path: "loop.max_steps", merge_operator: "hard_ceiling", value: 40 },
        { path: "paths.deny", merge_operator: "deny_union", value: [".git"] },
        { path: "paths.read.allow", merge_operator: "allow_intersection", value: ["src"] },
        { path: "approvals.required", merge_operator: "approval_union", value: ["risk:high"] },
        { path: "loop.max_tokens", merge_operator: "hard_ceiling", value: 120000 },
      ],
    });
    const first = previewPackUpgrade({ harnessRoot, lock, next });
    const second = previewPackUpgrade({ harnessRoot, lock, next });
    expect(second).toEqual(first);
    expect(HEX_DIGEST.test(first.digest)).toBe(true);
    expect(first.from_version).toBe("1.0.0");
    expect(first.policy_changes).toContainEqual({
      path: "loop.max_steps",
      change: "changed",
      merge_operator: "hard_ceiling",
    });
    expect(first.policy_changes).toContainEqual({
      path: "loop.max_tokens",
      change: "added",
      merge_operator: "hard_ceiling",
    });
    expect(HEX_DIGEST.test(first.effective_policy_digest_before)).toBe(true);
    expect(first.effective_policy_digest_after).not.toBe(first.effective_policy_digest_before);
  });

  it("refuses a downgrade or re-install of the same version", () => {
    const { harnessRoot, lock, v1 } = installV1();
    expect(() => previewPackUpgrade({ harnessRoot, lock, next: v1 })).toThrowError(PackError);
    expect(() =>
      previewPackUpgrade({ harnessRoot, lock, next: makePackDescriptor({ version: "0.9.0" }) }),
    ).toThrowError(PackError);
  });

  it("fails when the lockfile digest no longer matches the installed pack", () => {
    const { harnessRoot, v1 } = installV1();
    const staleLock = createPackLock([
      { name: PACK_NAME, version: "1.0.0", digest: "0".repeat(64) },
    ]);
    try {
      previewPackUpgrade({ harnessRoot, lock: staleLock, next: v2() });
      expect.unreachable();
    } catch (error) {
      expect((error as PackError).kind).toBe("digest_mismatch");
    }
    expect(packDigest(v1)).not.toBe("0".repeat(64));
  });
});

describe("applyPackUpgrade", () => {
  it("requires a well-formed approval digest bound to the preview", () => {
    const { harnessRoot, lock } = installV1();
    const next = v2();
    const preview = previewPackUpgrade({ harnessRoot, lock, next });
    expect(() =>
      applyPackUpgrade({
        harnessRoot,
        lock,
        next,
        approvalDigest: "not-a-digest",
        previewDigest: preview.digest,
      }),
    ).toThrowError(PackError);
    expect(() =>
      applyPackUpgrade({
        harnessRoot,
        lock,
        next,
        approvalDigest: APPROVAL,
        previewDigest: "b".repeat(64),
      }),
    ).toThrowError(PackError);
  });

  it("upgrades the snapshot, preserves overrides, updates the lock and records layer digests", () => {
    const { harnessRoot, projectRoot, lock } = installV1();
    writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("loop.max_steps", "hard_ceiling", 20)],
    });
    const next = v2();
    const preview = previewPackUpgrade({ harnessRoot, lock, next });
    const outcome = applyPackUpgrade({
      harnessRoot,
      lock,
      next,
      approvalDigest: APPROVAL,
      previewDigest: preview.digest,
    });

    expect(readUpstreamPack(harnessRoot, PACK_NAME).version).toBe("2.0.0");
    const override = readProjectPackOverride(harnessRoot, PACK_NAME);
    expect(override?.fields).toEqual([field("loop.max_steps", "hard_ceiling", 20)]);
    expect(override?.revision).toBe(1);
    const locked = readManagedPackLock(projectRoot);
    expect(locked.packs[0]?.version).toBe("2.0.0");
    expect(locked.packs[0]?.digest).toBe(packDigest(next));

    const record = JSON.parse(
      readFileSync(`${projectRoot}/.harness/${outcome.relativePath}`, "utf8"),
    ) as PackUpgradeRecord;
    expect(record.approval_digest).toBe(APPROVAL);
    expect(record.preview_digest).toBe(preview.digest);
    expect(record.layers.pack.digest).toBe(packDigest(next));
    expect(record.layers.project?.digest).toBeDefined();
    expect(record.effective_policy_digest).toBe(preview.effective_policy_digest_after);
    expect(record.digest).toBe(outcome.record.digest);
  });

  it("migrates project overrides through the registered chain and bumps their revision", () => {
    const { harnessRoot, lock } = installV1();
    writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("loop.max_steps", "hard_ceiling", 20)],
    });
    const next = v2({
      policies: [
        { path: "loop.step_ceiling", merge_operator: "hard_ceiling", value: 30 },
        { path: "paths.deny", merge_operator: "deny_union", value: [".git"] },
        { path: "paths.read.allow", merge_operator: "allow_intersection", value: ["src", "docs"] },
        { path: "approvals.required", merge_operator: "approval_union", value: ["risk:high"] },
      ],
    });
    const migrations: PackMigrationRegistry = {
      [PACK_NAME]: [
        {
          from_version: "1.0.0",
          to_version: "2.0.0",
          description: "rename loop.max_steps to loop.step_ceiling",
          migrate: (fields) =>
            fields.map((entry) =>
              entry.path === "loop.max_steps" ? { ...entry, path: "loop.step_ceiling" } : entry,
            ),
        },
      ],
    };
    const preview = previewPackUpgrade({ harnessRoot, lock, next, migrations });
    expect(preview.migration_applied).toHaveLength(1);
    expect(preview.incompatible_overrides).toEqual([]);
    applyPackUpgrade({
      harnessRoot,
      lock,
      next,
      migrations,
      approvalDigest: APPROVAL,
      previewDigest: preview.digest,
    });
    const override = readProjectPackOverride(harnessRoot, PACK_NAME);
    expect(override?.fields.map((entry) => entry.path)).toEqual(["loop.step_ceiling"]);
    expect(override?.revision).toBe(2);
  });

  it("refuses an upgrade whose overrides cannot migrate and leaves every file untouched", () => {
    const { harnessRoot, projectRoot, lock, v1 } = installV1();
    writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("loop.max_steps", "hard_ceiling", 20)],
    });
    // v2 drops loop.max_steps and registers no migration for it.
    const next = v2({
      policies: [
        { path: "paths.deny", merge_operator: "deny_union", value: [".git"] },
        { path: "paths.read.allow", merge_operator: "allow_intersection", value: ["src", "docs"] },
        { path: "approvals.required", merge_operator: "approval_union", value: ["risk:high"] },
      ],
    });
    const preview = previewPackUpgrade({ harnessRoot, lock, next });
    expect(preview.incompatible_overrides).toEqual(["loop.max_steps"]);
    try {
      applyPackUpgrade({
        harnessRoot,
        lock,
        next,
        approvalDigest: APPROVAL,
        previewDigest: preview.digest,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as PackError).kind).toBe("migration_failed");
    }
    // Rollback: upstream snapshot, override and lockfile keep their previous bytes.
    expect(readUpstreamPack(harnessRoot, PACK_NAME)).toEqual(v1);
    expect(readProjectPackOverride(harnessRoot, PACK_NAME)?.fields[0]?.path).toBe("loop.max_steps");
    expect(readManagedPackLock(projectRoot).packs[0]?.version).toBe("1.0.0");
  });

  it("blocks when the upgraded layers would produce a policy conflict", () => {
    const { harnessRoot, lock } = installV1();
    const next = v2({
      policies: [
        { path: "controls.trajectory", merge_operator: "strongest_control", value: "full" },
      ],
    });
    const installation = layer("installation", [
      field("controls.trajectory", "strongest_control", "not-a-visibility"),
    ]);
    const preview = previewPackUpgrade({ harnessRoot, lock, next, installation });
    expect(preview.policy_conflicts.length).toBeGreaterThan(0);
    try {
      applyPackUpgrade({
        harnessRoot,
        lock,
        next,
        installation,
        approvalDigest: APPROVAL,
        previewDigest: preview.digest,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as PackError).kind).toBe("policy_conflict");
    }
    expect(readUpstreamPack(harnessRoot, PACK_NAME).version).toBe("1.0.0");
  });
});
