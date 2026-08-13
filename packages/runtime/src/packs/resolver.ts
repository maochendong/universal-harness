import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  canonicalizeJson,
  contentDigest,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import {
  PackError as DescriptorError,
  packDigest,
  parsePackDescriptorJson,
  parsePackPolicyField,
  serializePackDescriptor,
  type PackDescriptor,
  type PackPolicyField,
} from "@universal-harness-internal/plugin-sdk";

import type { PolicyLayerInput } from "../policy/decision.js";

/**
 * Pack resolver (design section 5, plan Task 25 step 3). Upstream pack
 * content and project overrides are stored separately under `.harness`:
 *
 * - `packs/upstream/<key>/pack.json` holds the canonical, digested upstream
 *   descriptor exactly as installed -- upgrades replace it only through the
 *   transactional upgrade flow;
 * - `packs/project/<key>.json` holds the project override record the CLI must
 *   never overwrite on upgrade.
 *
 * Resolution produces the PolicyLayerInput views the Policy evaluator merges
 * field by field; there is no whole-object override anywhere in the flow.
 */
export const PACK_ERROR_KINDS = [
  "pack_not_found",
  "pack_conflict",
  "invalid_override",
  "digest_mismatch",
  "downgrade_refused",
  "approval_required",
  "stale_preview",
  "migration_unavailable",
  "migration_failed",
  "policy_conflict",
] as const;

export type PackErrorKind = (typeof PACK_ERROR_KINDS)[number];

export class PackError extends Error {
  readonly kind: PackErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: PackErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PackError";
    this.kind = kind;
    if (details !== undefined) this.details = details;
  }
}

export const PACKS_UPSTREAM_DIRECTORY = "packs/upstream";
export const PACKS_PROJECT_DIRECTORY = "packs/project";
export const PACKS_UPGRADES_DIRECTORY = "packs/upgrades";

const PACK_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/u;

/** Filesystem-safe storage key for a pack name (`@scope/name` -> `@scope__name`). */
export function packStorageKey(name: string): string {
  if (!PACK_NAME_PATTERN.test(name)) {
    throw new PackError("pack_not_found", `invalid pack name: ${JSON.stringify(name)}`);
  }
  return name.replace("/", "__");
}

/** Harness-relative path of the installed upstream descriptor. */
export function upstreamPackRelativePath(name: string): string {
  return `${PACKS_UPSTREAM_DIRECTORY}/${packStorageKey(name)}/pack.json`;
}

/** Harness-relative path of the project override record for a pack. */
export function projectOverrideRelativePath(name: string): string {
  return `${PACKS_PROJECT_DIRECTORY}/${packStorageKey(name)}.json`;
}

/** Harness-relative path of a recorded pack upgrade. */
export function packUpgradeRelativePath(recordDigest: string): string {
  return `${PACKS_UPGRADES_DIRECTORY}/${recordDigest}.json`;
}

export interface PackInstallOutcome {
  readonly relativePath: string;
  readonly action: "created" | "identical";
  readonly digest: string;
}

/**
 * Install an upstream pack snapshot. Re-installing identical content is an
 * idempotent no-op; diverging content under the same name is a typed conflict
 * -- only the upgrade flow may replace an installed pack.
 */
export function installUpstreamPack(
  harnessRoot: string,
  descriptor: PackDescriptor,
): PackInstallOutcome {
  const relativePath = upstreamPackRelativePath(descriptor.name);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const content = serializePackDescriptor(descriptor);
  const digest = packDigest(descriptor);
  if (existsSync(absolute)) {
    if (readFileSync(absolute, "utf8") === content) {
      return { relativePath, action: "identical", digest };
    }
    throw new PackError(
      "pack_conflict",
      `upstream pack ${descriptor.name} is already installed with different content; ` +
        "use the previewed upgrade flow instead of overwriting it",
    );
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return { relativePath, action: "created", digest };
}

/** Read the installed upstream descriptor, or fail with a typed error. */
export function readUpstreamPack(harnessRoot: string, name: string): PackDescriptor {
  const absolute = resolveHarnessPath(harnessRoot, upstreamPackRelativePath(name));
  if (!existsSync(absolute)) {
    throw new PackError("pack_not_found", `no upstream pack installed under the name ${name}`);
  }
  try {
    return parsePackDescriptorJson(readFileSync(absolute, "utf8"));
  } catch (error) {
    if (error instanceof DescriptorError) {
      throw new PackError(
        "pack_conflict",
        `installed pack ${name} is unreadable: ${error.message}`,
      );
    }
    throw error;
  }
}

/** Project override record stored separately from the upstream pack. */
export interface ProjectPackOverride {
  readonly pack: string;
  readonly revision: number;
  readonly fields: readonly PackPolicyField[];
}

/** Validate an untrusted override record. */
export function parseProjectPackOverride(raw: unknown): ProjectPackOverride {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PackError("invalid_override", "a project pack override must be an object");
  }
  const record = raw as Record<string, unknown>;
  const pack = record["pack"];
  if (typeof pack !== "string" || !PACK_NAME_PATTERN.test(pack)) {
    throw new PackError("invalid_override", "a project pack override must name a valid pack");
  }
  const revision = record["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new PackError(
      "invalid_override",
      "a project pack override revision must be a positive integer",
    );
  }
  const fields = record["fields"];
  if (!Array.isArray(fields)) {
    throw new PackError("invalid_override", "a project pack override fields must be an array");
  }
  let parsedFields: readonly PackPolicyField[];
  try {
    parsedFields = fields.map(parsePackPolicyField);
  } catch (error) {
    if (error instanceof DescriptorError) {
      throw new PackError("invalid_override", error.message);
    }
    throw error;
  }
  const paths = new Set<string>();
  for (const field of parsedFields) {
    if (paths.has(field.path)) {
      throw new PackError(
        "invalid_override",
        `project override for ${pack} declares field ${field.path} twice`,
      );
    }
    paths.add(field.path);
  }
  return { pack, revision, fields: parsedFields };
}

export function serializeProjectPackOverride(override: ProjectPackOverride): string {
  return `${canonicalizeJson(override)}\n`;
}

export interface OverrideWriteOutcome {
  readonly relativePath: string;
  readonly revision: number;
  readonly digest: string;
}

function overrideDigest(override: ProjectPackOverride): string {
  return contentDigest({
    pack: override.pack,
    revision: override.revision,
    fields: override.fields,
  });
}

/**
 * Write a project override record. A different record under the same pack
 * requires `replace: true` and bumps the revision, so every override state is
 * digest-addressable and upgrades can prove they preserved it.
 */
export function writeProjectPackOverride(
  harnessRoot: string,
  override: { readonly pack: string; readonly fields: readonly PackPolicyField[] },
  options?: { readonly replace?: boolean },
): OverrideWriteOutcome {
  const relativePath = projectOverrideRelativePath(override.pack);
  const absolute = resolveHarnessPath(harnessRoot, relativePath);
  const existing = existsSync(absolute)
    ? parseProjectPackOverride(JSON.parse(readFileSync(absolute, "utf8")))
    : undefined;
  const sameFields =
    existing !== undefined &&
    contentDigest(existing.fields) === contentDigest(override.fields as readonly unknown[]);
  if (existing !== undefined && !sameFields && options?.replace !== true) {
    throw new PackError(
      "pack_conflict",
      `project override for ${override.pack} already exists with different fields; ` +
        "pass replace to supersede it with a new revision",
    );
  }
  const record: ProjectPackOverride = {
    pack: override.pack,
    revision: existing === undefined ? 1 : sameFields ? existing.revision : existing.revision + 1,
    fields: override.fields,
  };
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, serializeProjectPackOverride(record), "utf8");
  return { relativePath, revision: record.revision, digest: overrideDigest(record) };
}

/** Read the project override for a pack, or undefined when none exists. */
export function readProjectPackOverride(
  harnessRoot: string,
  name: string,
): ProjectPackOverride | undefined {
  const absolute = resolveHarnessPath(harnessRoot, projectOverrideRelativePath(name));
  if (!existsSync(absolute)) return undefined;
  return parseProjectPackOverride(JSON.parse(readFileSync(absolute, "utf8")));
}

export { overrideDigest as projectPackOverrideDigest };

/** Policy layer views of one installed pack, ready for field-wise merge. */
export interface ResolvedPackPolicyLayers {
  readonly pack: PolicyLayerInput;
  readonly project?: PolicyLayerInput;
}

/**
 * Resolve the pack and project policy layers for an installed pack. The pack
 * layer digest is the canonical descriptor digest the lockfile pins; the
 * project layer digest binds the exact override revision, so an upgrade that
 * changes either one is visible in every later effective policy digest.
 */
export function resolvePackPolicyLayers(
  harnessRoot: string,
  name: string,
): ResolvedPackPolicyLayers {
  const descriptor = readUpstreamPack(harnessRoot, name);
  const override = readProjectPackOverride(harnessRoot, name);
  const pack: PolicyLayerInput = {
    layer: "pack",
    revision: 1,
    digest: packDigest(descriptor),
    fields: descriptor.policies,
  };
  if (override === undefined) return { pack };
  return {
    pack,
    project: {
      layer: "project",
      revision: override.revision,
      digest: overrideDigest(override),
      fields: override.fields,
    },
  };
}
