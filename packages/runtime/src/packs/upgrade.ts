import {
  PACK_LOCK_RELATIVE_PATH,
  canonicalizeJson,
  contentDigest,
  resolveHarnessPath,
  serializePackLock,
  type PackLock,
} from "@universal-harness-internal/core";
import {
  packDigest,
  serializePackDescriptor,
  type PackDescriptor,
  type PackPolicyField,
} from "@universal-harness-internal/plugin-sdk";

import { mergePolicyLayers } from "../policy/evaluator.js";
import type { PolicyLayerInput, PolicyLayerRef } from "../policy/decision.js";
import { assertLockMatchesPack, lockEntryForPack, upsertLockedPack } from "./lockfile.js";
import {
  commitTransactionalWrites,
  comparePackVersions,
  planPackMigration,
  runPackMigration,
  type PackMigrationRegistry,
  type TransactionalWrite,
} from "./migration.js";
import {
  PackError,
  packUpgradeRelativePath,
  projectOverrideRelativePath,
  readProjectPackOverride,
  readUpstreamPack,
  serializeProjectPackOverride,
  upstreamPackRelativePath,
  type ProjectPackOverride,
} from "./resolver.js";

/**
 * Pack upgrade flow (design section 5, plan Task 25 step 4). An upgrade is an
 * explicit, previewable operation: the preview diffs policy fields, gates and
 * templates between the installed upstream snapshot and the candidate
 * descriptor, and its digest is what the approval binds. Applying the upgrade
 * re-runs the exact same computation, refuses a stale preview digest, migrates
 * project overrides through the registered chain, and commits the new
 * upstream snapshot, the preserved overrides, the updated lockfile and the
 * upgrade record in one transactional write batch. Any failure before the
 * commit leaves every byte untouched.
 */

export interface PackPolicyChange {
  readonly path: string;
  readonly change: "added" | "removed" | "changed";
  readonly merge_operator?: string;
}

export interface PackGateChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface PackUpgradePreview {
  readonly name: string;
  readonly from_version: string;
  readonly from_digest: string;
  readonly to_version: string;
  readonly to_digest: string;
  readonly policy_changes: readonly PackPolicyChange[];
  readonly gate_changes: PackGateChanges;
  /** Template keys whose content was added, removed or changed. */
  readonly templates_changed: readonly string[];
  /** Migration chain summaries applied to the project override, if any. */
  readonly migration_applied: readonly string[];
  /**
   * Project override fields that no target policy field accepts (unknown path
   * or changed merge operator). A non-empty list blocks the upgrade.
   */
  readonly incompatible_overrides: readonly string[];
  /** Policy merge conflicts the upgraded layers would produce; blocks apply. */
  readonly policy_conflicts: readonly string[];
  readonly effective_policy_digest_before: string;
  readonly effective_policy_digest_after: string;
  readonly digest: string;
}

export interface PackUpgradeRecord {
  readonly name: string;
  readonly from_version: string;
  readonly from_digest: string;
  readonly to_version: string;
  readonly to_digest: string;
  readonly approval_digest: string;
  readonly preview_digest: string;
  readonly migration_applied: readonly string[];
  /** Policy revision/digest of every layer after the upgrade. */
  readonly layers: {
    readonly installation?: PolicyLayerRef;
    readonly pack: PolicyLayerRef;
    readonly project?: PolicyLayerRef;
  };
  readonly effective_policy_digest: string;
  readonly digest: string;
}

export interface PackUpgradeInput {
  readonly harnessRoot: string;
  readonly lock: PackLock;
  readonly next: PackDescriptor;
  readonly installation?: PolicyLayerInput;
  readonly migrations?: PackMigrationRegistry;
}

const APPROVAL_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function policyChanges(
  current: readonly PackPolicyField[],
  next: readonly PackPolicyField[],
): readonly PackPolicyChange[] {
  const currentByPath = new Map(current.map((field) => [field.path, field]));
  const nextByPath = new Map(next.map((field) => [field.path, field]));
  const changes: PackPolicyChange[] = [];
  for (const path of [...new Set([...currentByPath.keys(), ...nextByPath.keys()])].sort()) {
    const before = currentByPath.get(path);
    const after = nextByPath.get(path);
    if (before === undefined && after !== undefined) {
      changes.push({ path, change: "added", merge_operator: after.merge_operator });
    } else if (before !== undefined && after === undefined) {
      changes.push({ path, change: "removed", merge_operator: before.merge_operator });
    } else if (
      before !== undefined &&
      after !== undefined &&
      (before.merge_operator !== after.merge_operator ||
        contentDigest(before.value) !== contentDigest(after.value))
    ) {
      changes.push({ path, change: "changed", merge_operator: after.merge_operator });
    }
  }
  return changes;
}

function gateChanges(current: PackDescriptor, next: PackDescriptor): PackGateChanges {
  const digestOf = (descriptor: PackDescriptor, gateId: string): string =>
    contentDigest(descriptor.gates.find((gate) => gate.gate_id === gateId));
  const currentIds = new Set(current.gates.map((gate) => gate.gate_id));
  const nextIds = new Set(next.gates.map((gate) => gate.gate_id));
  const sort = (values: Iterable<string>): readonly string[] => [...values].sort();
  return {
    added: sort([...nextIds].filter((id) => !currentIds.has(id))),
    removed: sort([...currentIds].filter((id) => !nextIds.has(id))),
    changed: sort(
      [...nextIds].filter(
        (id) => currentIds.has(id) && digestOf(current, id) !== digestOf(next, id),
      ),
    ),
  };
}

function templatesChanged(current: PackDescriptor, next: PackDescriptor): readonly string[] {
  const keys = new Set([...Object.keys(current.templates), ...Object.keys(next.templates)]);
  return [...keys].filter((key) => current.templates[key] !== next.templates[key]).sort();
}

function packLayer(descriptor: PackDescriptor): PolicyLayerInput {
  return {
    layer: "pack",
    revision: 1,
    digest: packDigest(descriptor),
    fields: descriptor.policies,
  };
}

function projectLayer(override: ProjectPackOverride): PolicyLayerInput {
  return {
    layer: "project",
    revision: override.revision,
    digest: contentDigest({
      pack: override.pack,
      revision: override.revision,
      fields: override.fields,
    }),
    fields: override.fields,
  };
}

function layerRef(layer: PolicyLayerInput): PolicyLayerRef {
  return { layer: layer.layer, revision: layer.revision, digest: layer.digest };
}

function effectiveDigest(layers: readonly PolicyLayerInput[]): {
  readonly digest: string;
  readonly conflicts: readonly string[];
} {
  const merged = mergePolicyLayers(layers);
  return { digest: merged.effective.digest, conflicts: merged.conflicts };
}

interface UpgradeComputation {
  readonly current: PackDescriptor;
  readonly overrideBefore: ProjectPackOverride | undefined;
  readonly overrideAfter: ProjectPackOverride | undefined;
  readonly migrationApplied: readonly string[];
  readonly incompatibleOverrides: readonly string[];
  readonly preview: PackUpgradePreview;
}

/**
 * Shared, deterministic computation behind preview and apply: apply re-runs
 * this and binds the caller's approval to the resulting preview digest, so
 * what was approved is exactly what gets committed.
 */
function computeUpgrade(input: PackUpgradeInput): UpgradeComputation {
  const current = readUpstreamPack(input.harnessRoot, input.next.name);
  assertLockMatchesPack(input.lock, current);
  if (comparePackVersions(input.next.version, current.version) <= 0) {
    throw new PackError(
      "downgrade_refused",
      `pack ${input.next.name} is installed at ${current.version}; ` +
        `${input.next.version} is not an upgrade`,
    );
  }

  const overrideBefore = readProjectPackOverride(input.harnessRoot, input.next.name);
  let overrideAfter: ProjectPackOverride | undefined;
  let migrationApplied: readonly string[] = [];
  const incompatible: string[] = [];
  if (overrideBefore !== undefined) {
    let migratedFields = overrideBefore.fields;
    if (input.migrations !== undefined) {
      const chain = planPackMigration(
        input.migrations,
        input.next.name,
        current.version,
        input.next.version,
      );
      if (chain.length > 0) {
        const outcome = runPackMigration(chain, overrideBefore.fields);
        migratedFields = outcome.fields;
        migrationApplied = outcome.applied;
      }
    }
    const nextByPath = new Map(input.next.policies.map((field) => [field.path, field]));
    for (const field of migratedFields) {
      const target = nextByPath.get(field.path);
      if (target === undefined || target.merge_operator !== field.merge_operator) {
        incompatible.push(field.path);
      }
    }
    const changed = contentDigest(migratedFields) !== contentDigest(overrideBefore.fields);
    overrideAfter = {
      pack: overrideBefore.pack,
      revision: changed ? overrideBefore.revision + 1 : overrideBefore.revision,
      fields: migratedFields,
    };
  }

  const layersBefore: PolicyLayerInput[] = [
    ...(input.installation === undefined ? [] : [input.installation]),
    packLayer(current),
    ...(overrideBefore === undefined ? [] : [projectLayer(overrideBefore)]),
  ];
  const layersAfter: PolicyLayerInput[] = [
    ...(input.installation === undefined ? [] : [input.installation]),
    packLayer(input.next),
    ...(overrideAfter === undefined ? [] : [projectLayer(overrideAfter)]),
  ];
  const before = effectiveDigest(layersBefore);
  const after = effectiveDigest(layersAfter);

  const parts = {
    name: input.next.name,
    from_version: current.version,
    from_digest: packDigest(current),
    to_version: input.next.version,
    to_digest: packDigest(input.next),
    policy_changes: policyChanges(current.policies, input.next.policies),
    gate_changes: gateChanges(current, input.next),
    templates_changed: templatesChanged(current, input.next),
    migration_applied: migrationApplied,
    incompatible_overrides: [...incompatible].sort(),
    policy_conflicts: after.conflicts,
    effective_policy_digest_before: before.digest,
    effective_policy_digest_after: after.digest,
  };
  return {
    current,
    overrideBefore,
    overrideAfter,
    migrationApplied,
    incompatibleOverrides: incompatible,
    preview: { ...parts, digest: contentDigest(parts) },
  };
}

/**
 * Compute the upgrade preview without touching disk. The preview digest is
 * the value an approval binds; nothing in this function mutates state.
 */
export function previewPackUpgrade(input: PackUpgradeInput): PackUpgradePreview {
  return computeUpgrade(input).preview;
}

export interface PackUpgradeOutcome {
  readonly record: PackUpgradeRecord;
  /** The updated lock; the caller persists it through the write batch too. */
  readonly lock: PackLock;
  readonly relativePath: string;
}

/**
 * Apply a previewed upgrade. The approval is bound to the preview digest: a
 * missing or malformed approval digest is `approval_required`, a digest that
 * no longer matches the recomputed preview is `stale_preview`. Incompatible
 * overrides or policy conflicts refuse the upgrade before any write; the
 * commit itself is one transactional batch, so a failure mid-write rolls
 * every file back to its previous bytes.
 */
export function applyPackUpgrade(
  input: PackUpgradeInput & {
    readonly approvalDigest: string;
    readonly previewDigest: string;
  },
): PackUpgradeOutcome {
  if (!APPROVAL_DIGEST_PATTERN.test(input.approvalDigest)) {
    throw new PackError(
      "approval_required",
      "a pack upgrade requires an approval digest binding the upgrade preview",
    );
  }
  const computation = computeUpgrade(input);
  const { preview } = computation;
  if (preview.digest !== input.previewDigest) {
    throw new PackError(
      "stale_preview",
      `the approved preview digest ${input.previewDigest} does not match the current ` +
        `preview ${preview.digest}; re-approve the upgrade`,
    );
  }
  if (preview.incompatible_overrides.length > 0) {
    throw new PackError(
      "migration_failed",
      `project overrides cannot migrate to ${preview.to_version}: no compatible target ` +
        `field for ${preview.incompatible_overrides.join(", ")}; the upgrade is refused ` +
        "and every managed file keeps its previous bytes",
      { incompatible: preview.incompatible_overrides },
    );
  }
  if (preview.policy_conflicts.length > 0) {
    throw new PackError(
      "policy_conflict",
      `the upgraded policy layers conflict: ${preview.policy_conflicts.join("; ")}`,
      { conflicts: preview.policy_conflicts },
    );
  }

  const newLock = upsertLockedPack(input.lock, lockEntryForPack(input.next));
  const layers: PackUpgradeRecord["layers"] = {
    ...(input.installation === undefined ? {} : { installation: layerRef(input.installation) }),
    pack: { layer: "pack", revision: 1, digest: preview.to_digest },
    ...(computation.overrideAfter === undefined
      ? {}
      : { project: layerRef(projectLayer(computation.overrideAfter)) }),
  };
  const recordParts = {
    name: preview.name,
    from_version: preview.from_version,
    from_digest: preview.from_digest,
    to_version: preview.to_version,
    to_digest: preview.to_digest,
    approval_digest: input.approvalDigest,
    preview_digest: preview.digest,
    migration_applied: preview.migration_applied,
    layers,
    effective_policy_digest: preview.effective_policy_digest_after,
  };
  const record: PackUpgradeRecord = { ...recordParts, digest: contentDigest(recordParts) };

  const writes: TransactionalWrite[] = [
    {
      path: resolveHarnessPath(input.harnessRoot, upstreamPackRelativePath(preview.name)),
      content: serializePackDescriptor(input.next),
    },
    {
      path: resolveHarnessPath(input.harnessRoot, PACK_LOCK_RELATIVE_PATH),
      content: serializePackLock(newLock),
    },
    {
      path: resolveHarnessPath(input.harnessRoot, packUpgradeRelativePath(record.digest)),
      content: `${canonicalizeJson(record)}\n`,
    },
  ];
  if (computation.overrideAfter !== undefined) {
    writes.push({
      path: resolveHarnessPath(input.harnessRoot, projectOverrideRelativePath(preview.name)),
      content: serializeProjectPackOverride(computation.overrideAfter),
    });
  }
  commitTransactionalWrites(writes);
  return { record, lock: newLock, relativePath: packUpgradeRelativePath(record.digest) };
}
