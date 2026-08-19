import { contentDigest } from "../identity/digest.js";
import type { ApprovalObjectKind, BindingKind, ProviderCapability } from "../schema/capability.js";
import { CAPABILITY_IDS, type CapabilityId } from "../schema/profile.js";

/**
 * Capability Module contract and the five built-in Protocol 1.1 modules
 * (slim-profiles design 6). Modules do not own ledgers or bypass the Kernel;
 * they declare their authoritative inputs/outputs, capability and provider
 * dependencies, checkpoint boundary, invalidation triggers and real approval
 * objects, and the compiler turns those declarations into the Operation DAG.
 * Every definition is sealed with a deterministic digest so a definition
 * drift between versions fails closed downstream.
 */
export type CheckpointBoundary = string;

export interface CapabilityModuleDefinition {
  readonly capability_id: CapabilityId;
  readonly version: string;
  readonly depends_on: readonly CapabilityId[];
  readonly required_providers: readonly ProviderCapability[];
  readonly input_bindings: readonly BindingKind[];
  readonly output_bindings: readonly BindingKind[];
  readonly checkpoint_boundary: CheckpointBoundary;
  readonly invalidated_by: readonly BindingKind[];
  readonly approval_objects: readonly ApprovalObjectKind[];
  readonly definition_digest: string;
}

export class CapabilityRegistryError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid capability registry: ${reason}`);
    this.name = "CapabilityRegistryError";
    this.reason = reason;
  }
}

const MODULE_VERSION = "1.1.0";

function defineModule(
  definition: Omit<CapabilityModuleDefinition, "version" | "definition_digest">,
): CapabilityModuleDefinition {
  const sealed = { ...definition, version: MODULE_VERSION } as const;
  return { ...sealed, definition_digest: contentDigest(sealed) };
}

export const CAPABILITY_MODULE_DEFINITIONS: readonly CapabilityModuleDefinition[] = [
  defineModule({
    capability_id: "impact_analysis",
    depends_on: [],
    required_providers: [],
    input_bindings: ["requirement_baseline"],
    output_bindings: ["impact_set"],
    checkpoint_boundary: "impact",
    invalidated_by: ["requirement_baseline"],
    approval_objects: ["impact_set"],
  }),
  defineModule({
    capability_id: "design_governance",
    depends_on: ["impact_analysis"],
    required_providers: [],
    input_bindings: ["impact_set"],
    output_bindings: ["design_set"],
    checkpoint_boundary: "design",
    invalidated_by: ["impact_set"],
    approval_objects: ["design_set"],
  }),
  defineModule({
    capability_id: "independent_evaluation",
    depends_on: [],
    required_providers: [],
    input_bindings: ["gate_evidence"],
    output_bindings: ["evaluation_report"],
    checkpoint_boundary: "evaluate",
    invalidated_by: ["gate_evidence"],
    approval_objects: [],
  }),
  defineModule({
    capability_id: "strict_tdd",
    depends_on: ["design_governance"],
    required_providers: ["isolated_workspace_provider", "structured_gate_provider"],
    input_bindings: ["design_set"],
    output_bindings: ["tdd_contract"],
    checkpoint_boundary: "execute",
    invalidated_by: ["design_set"],
    approval_objects: [],
  }),
  defineModule({
    capability_id: "advanced_audit",
    depends_on: [],
    required_providers: [],
    input_bindings: ["snapshot"],
    output_bindings: ["audit_report"],
    checkpoint_boundary: "audit",
    invalidated_by: ["snapshot"],
    approval_objects: [],
  }),
];

const BUILTIN_MODULES = new Map(
  CAPABILITY_MODULE_DEFINITIONS.map((module) => [module.capability_id, module]),
);

/** Fail-closed lookup: unknown capabilities are rejected, never ignored. */
export function capabilityModuleDefinition(capabilityId: string): CapabilityModuleDefinition {
  const definition = BUILTIN_MODULES.get(capabilityId as CapabilityId);
  if (definition === undefined) {
    throw new CapabilityRegistryError(`unknown capability: ${capabilityId}`);
  }
  return definition;
}

/** Recompute and compare every built-in definition digest. */
export function verifyModuleDefinitionDigests(): boolean {
  return CAPABILITY_MODULE_DEFINITIONS.every((module) => {
    const { definition_digest: digest, ...rest } = module;
    return contentDigest(rest) === digest;
  });
}

/**
 * Transitive dependency closure over an explicit module graph (design 6.3).
 * The result is canonically sorted; unknown capabilities and dependency
 * cycles fail closed instead of producing a partial plan.
 */
export function dependencyClosure(
  definitions: readonly CapabilityModuleDefinition[],
  requested: readonly string[],
): CapabilityId[] {
  const modules = new Map(definitions.map((module) => [module.capability_id, module]));
  for (const module of definitions) {
    for (const dependency of module.depends_on) {
      if (!modules.has(dependency)) {
        throw new CapabilityRegistryError(
          `unknown capability: ${dependency} (dependency of ${module.capability_id})`,
        );
      }
    }
  }
  for (const capabilityId of requested) {
    if (!modules.has(capabilityId as CapabilityId)) {
      throw new CapabilityRegistryError(`unknown capability: ${capabilityId}`);
    }
  }

  // Iterative DFS with an in-progress set: revisiting an in-progress module
  // means the dependency graph contains a cycle.
  const closed = new Set<CapabilityId>();
  const inProgress = new Set<CapabilityId>();
  const visit = (capabilityId: CapabilityId): void => {
    if (closed.has(capabilityId)) return;
    if (inProgress.has(capabilityId)) {
      throw new CapabilityRegistryError(`dependency cycle at capability: ${capabilityId}`);
    }
    inProgress.add(capabilityId);
    const module = modules.get(capabilityId);
    if (module === undefined) {
      throw new CapabilityRegistryError(`unknown capability: ${capabilityId}`);
    }
    for (const dependency of module.depends_on) {
      visit(dependency);
    }
    inProgress.delete(capabilityId);
    closed.add(capabilityId);
  };
  for (const capabilityId of requested) {
    visit(capabilityId as CapabilityId);
  }
  return [...closed].sort();
}

/** Dependency closure over the built-in protocol registry. */
export function capabilityDependencyClosure(requested: readonly string[]): CapabilityId[] {
  return dependencyClosure(CAPABILITY_MODULE_DEFINITIONS, requested);
}

/** All capability ids the registry knows, in canonical order. */
export function registeredCapabilityIds(): readonly CapabilityId[] {
  return [...CAPABILITY_IDS].sort();
}
