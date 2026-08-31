import { contentDigest } from "../identity/digest.js";
import { PROTOCOL_1_1_VERSION, PROTOCOL_1_3_VERSION } from "../protocol.js";
import type {
  ApprovalObjectKind,
  BindingKindV13,
  ProviderCapability,
} from "../schema/capability.js";
import { CAPABILITY_IDS, CAPABILITY_IDS_1_3, type CapabilityIdV13 } from "../schema/profile.js";

/**
 * Capability Module contract and the built-in modules (slim-profiles design
 * 6; M4 design 10.2). Modules do not own ledgers or bypass the Kernel; they
 * declare their authoritative inputs/outputs, capability and provider
 * dependencies, checkpoint boundary, invalidation triggers and real approval
 * objects, and the compiler turns those declarations into the Operation DAG.
 * Every definition is sealed with a deterministic digest so a definition
 * drift between versions fails closed downstream.
 *
 * The registry is versioned: Protocol 1.0–1.2 resolve the five 1.1 modules;
 * Protocol 1.3 adds `parallel_task_execution` as a new sealed definition
 * without rotating any 1.1 digest.
 */
export type CheckpointBoundary = string;

export interface CapabilityModuleDefinition {
  readonly capability_id: CapabilityIdV13;
  readonly version: string;
  readonly depends_on: readonly CapabilityIdV13[];
  readonly required_providers: readonly ProviderCapability[];
  readonly input_bindings: readonly BindingKindV13[];
  readonly output_bindings: readonly BindingKindV13[];
  readonly checkpoint_boundary: CheckpointBoundary;
  readonly invalidated_by: readonly BindingKindV13[];
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

const MODULE_VERSION_1_1 = "1.1.0";
const MODULE_VERSION_1_3 = "1.3.0";

function defineModule(
  version: string,
  definition: Omit<CapabilityModuleDefinition, "version" | "definition_digest">,
): CapabilityModuleDefinition {
  const sealed = { ...definition, version } as const;
  return { ...sealed, definition_digest: contentDigest(sealed) };
}

export const CAPABILITY_MODULE_DEFINITIONS: readonly CapabilityModuleDefinition[] = [
  defineModule(MODULE_VERSION_1_1, {
    capability_id: "impact_analysis",
    depends_on: [],
    required_providers: [],
    input_bindings: ["requirement_baseline"],
    output_bindings: ["impact_set"],
    checkpoint_boundary: "impact",
    invalidated_by: ["requirement_baseline"],
    approval_objects: ["impact_set"],
  }),
  defineModule(MODULE_VERSION_1_1, {
    capability_id: "design_governance",
    depends_on: ["impact_analysis"],
    required_providers: [],
    input_bindings: ["impact_set"],
    output_bindings: ["design_set"],
    checkpoint_boundary: "design",
    invalidated_by: ["impact_set"],
    approval_objects: ["design_set"],
  }),
  defineModule(MODULE_VERSION_1_1, {
    capability_id: "independent_evaluation",
    depends_on: [],
    required_providers: [],
    input_bindings: ["gate_evidence"],
    output_bindings: ["evaluation_report"],
    checkpoint_boundary: "evaluate",
    invalidated_by: ["gate_evidence"],
    approval_objects: [],
  }),
  defineModule(MODULE_VERSION_1_1, {
    capability_id: "strict_tdd",
    depends_on: ["design_governance"],
    required_providers: ["isolated_workspace_provider", "structured_gate_provider"],
    input_bindings: ["design_set"],
    output_bindings: ["tdd_contract"],
    checkpoint_boundary: "execute",
    invalidated_by: ["design_set"],
    approval_objects: [],
  }),
  defineModule(MODULE_VERSION_1_1, {
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

/**
 * Protocol 1.3 parallel execution module (M4 design 10.2). It depends on the
 * Evidence Kernel alone — Strict TDD stays optional — and contributes only the
 * outer `execute` subgraph plus the `wave_integration` output; `gate_evidence`
 * remains produced solely by the Kernel `verify` node. Scheduling actions
 * create exact ApprovalRequests on Policy demand, so the module declares no
 * fixed approval objects.
 */
export const PARALLEL_TASK_EXECUTION_MODULE: CapabilityModuleDefinition = defineModule(
  MODULE_VERSION_1_3,
  {
    capability_id: "parallel_task_execution",
    depends_on: [],
    required_providers: ["isolated_workspace_provider", "structured_gate_provider"],
    input_bindings: ["execution_plan", "context_bundle"],
    output_bindings: ["wave_integration"],
    checkpoint_boundary: "execute",
    invalidated_by: ["execution_plan", "context_bundle"],
    approval_objects: [],
  },
);

export const CAPABILITY_MODULE_DEFINITIONS_1_3: readonly CapabilityModuleDefinition[] = [
  ...CAPABILITY_MODULE_DEFINITIONS,
  PARALLEL_TASK_EXECUTION_MODULE,
];

/**
 * Which module definition set an operation protocol resolves. Protocol
 * 1.0–1.2 keep the 1.1 modules; unknown versions fail closed.
 */
export function capabilityModuleDefinitionsForProtocol(
  protocolVersion: string,
): readonly CapabilityModuleDefinition[] {
  switch (protocolVersion) {
    case "1.0.0":
    case PROTOCOL_1_1_VERSION:
    case "1.2.0":
      return CAPABILITY_MODULE_DEFINITIONS;
    case PROTOCOL_1_3_VERSION:
      return CAPABILITY_MODULE_DEFINITIONS_1_3;
    default:
      throw new CapabilityRegistryError(`unsupported protocol version: ${protocolVersion}`);
  }
}

/** Fail-closed lookup: unknown capabilities are rejected, never ignored. */
export function capabilityModuleDefinition(
  capabilityId: string,
  protocolVersion: string = PROTOCOL_1_1_VERSION,
): CapabilityModuleDefinition {
  const definitions = capabilityModuleDefinitionsForProtocol(protocolVersion);
  const definition = definitions.find((module) => module.capability_id === capabilityId);
  if (definition === undefined) {
    throw new CapabilityRegistryError(`unknown capability: ${capabilityId}`);
  }
  return definition;
}

/** Recompute and compare every built-in definition digest of both versions. */
export function verifyModuleDefinitionDigests(): boolean {
  return [...CAPABILITY_MODULE_DEFINITIONS, PARALLEL_TASK_EXECUTION_MODULE].every((module) => {
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
): CapabilityIdV13[] {
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
    if (!modules.has(capabilityId as CapabilityIdV13)) {
      throw new CapabilityRegistryError(`unknown capability: ${capabilityId}`);
    }
  }

  // Iterative DFS with an in-progress set: revisiting an in-progress module
  // means the dependency graph contains a cycle.
  const closed = new Set<CapabilityIdV13>();
  const inProgress = new Set<CapabilityIdV13>();
  const visit = (capabilityId: CapabilityIdV13): void => {
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
    visit(capabilityId as CapabilityIdV13);
  }
  return [...closed].sort();
}

/** Dependency closure over the built-in protocol registry of the given version. */
export function capabilityDependencyClosure(
  requested: readonly string[],
  protocolVersion: string = PROTOCOL_1_1_VERSION,
): CapabilityIdV13[] {
  return dependencyClosure(capabilityModuleDefinitionsForProtocol(protocolVersion), requested);
}

/** All capability ids the given protocol version knows, in canonical order. */
export function registeredCapabilityIds(
  protocolVersion: string = PROTOCOL_1_1_VERSION,
): readonly CapabilityIdV13[] {
  capabilityModuleDefinitionsForProtocol(protocolVersion);
  const ids = protocolVersion === PROTOCOL_1_3_VERSION ? CAPABILITY_IDS_1_3 : CAPABILITY_IDS;
  return [...ids].sort();
}
