import { canonicalStringSet } from "../identity/canonical-set.js";
import { domainRecordId } from "../identity/record-id.js";
import { PromptContractError } from "../prompt/contracts.js";
import type { PromptContractResolver } from "../prompt/registry.js";
import type { ProfilePolicyConstraints } from "../profile/decisions.js";
import {
  profileDefinitionForProtocol,
  profileDefinitionVersionForProtocol,
} from "../profile/definitions.js";
import {
  assertBindingScopesDisjoint,
  bindingScopeKey,
  isCaptureScopeBinding,
  modelSlotDefaultsForProfile,
} from "../profile/model-slots.js";
import { PROTOCOL_1_1_VERSION, PROTOCOL_1_3_VERSION } from "../protocol.js";
import type {
  AnyCapabilityPlanRecord,
  ApprovalObjectKind,
  CapabilityPlanRecord,
  CapabilityResolutionEntry,
  CapabilityResolutionEntryV13,
  CapabilityResolutionSource,
  CompilationStage,
  InvalidationEdgeV13,
  ProviderCapability,
} from "../schema/capability.js";
import { PROVIDER_CAPABILITIES } from "../schema/capability.js";
import { sealRecordEnvelope } from "../schema/envelope.js";
import {
  GROUNDED_SYNTHESIS_PURPOSES,
  MODEL_SLOT_IDS,
  type CapabilityId,
  type CapabilityIdV13,
  type CapabilityMode,
  type GroundedSynthesisPurpose,
  type ModelBindingFailureMode,
  type ModelProviderBinding,
  type ModelSlotId,
  type ProfileDecisionRecord,
  type ProfileDefinition,
  type ProfileId,
  type ProjectProfileRecord,
} from "../schema/profile.js";
import { buildOperationDag, validateOperationDag, type OperationDagNode } from "./dag.js";
import {
  capabilityDependencyClosure,
  capabilityModuleDefinition,
  registeredCapabilityIds,
} from "./registry.js";

/**
 * Capability Compiler (slim-profiles design 8.4, 9; model advisory 11). From
 * the ProjectProfile, risk, Policy, registered providers and accepted
 * bindings it deterministically compiles the CapabilityPlanRecord: resolved
 * capability set with dependency closure, provider closure, purpose-bound
 * ModelProviderBindings with failure modes, the approval object policy, the
 * Operation DAG and the invalidation graph. The same canonical input always
 * produces the same plan digest; every illegal shape is a compile blocker,
 * never a silent fallback to a lower profile.
 */
export class CapabilityCompileError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "CapabilityCompileError";
    this.kind = kind;
  }
}

export interface CapabilityActivation {
  readonly capability_id: CapabilityIdV13;
  readonly source: "user_activation" | "risk_activation";
  /** Digest of the object justifying the activation; defaults per source. */
  readonly binding_digest?: string;
}

/** Provider configuration offered for one operation-scope model slot. */
export interface ModelProviderConfig {
  readonly slot_id: ModelSlotId;
  readonly purpose?: GroundedSynthesisPurpose;
  readonly provider_identity: string;
  readonly config_digest: string;
  readonly prompt_version: string;
  readonly schema_version: string;
  readonly budget_profile: string;
  /** Optional pin; must equal the profile matrix default when present. */
  readonly failure_mode?: ModelBindingFailureMode;
}

/**
 * Placeholder for the accepted DesignSet/test_strategy the final stage binds
 * (the DesignSet domain itself lands in Tasks 11/12).
 */
export interface AcceptedDesignSetInput {
  readonly design_set_digest: string;
  readonly test_strategy_digest: string;
}

export interface CapabilityPlanCompileInput {
  readonly operation_id: string;
  readonly stage: CompilationStage;
  readonly project_profile: ProjectProfileRecord;
  readonly profile_decision: ProfileDecisionRecord;
  readonly requirement_digest: string;
  readonly risk_digest: string;
  readonly policy_digest: string;
  readonly baseline_digest: string;
  readonly policy?: ProfilePolicyConstraints;
  readonly activations?: readonly CapabilityActivation[];
  readonly providers?: readonly ProviderCapability[];
  readonly model_providers?: readonly ModelProviderConfig[];
  /**
   * The prompt contract resolver every compiled binding derives its contract
   * id/version/digest and output schema digest from (prompt governance
   * addendum 5.2). Required whenever a binding is compiled; Lite plans with
   * zero bindings compile without it.
   */
  readonly prompt_contract_resolver?: PromptContractResolver;
  /** The Capture-scope bindings (Task 2 record) for scope-overlap verification. */
  readonly capture_scope_bindings?: readonly ModelProviderBinding[];
  readonly accepted_design_set?: AcceptedDesignSetInput;
  readonly supersedes?: AnyCapabilityPlanRecord;
  /**
   * Operation protocol selecting the capability/profile definition set
   * (M4 design 10.2). Protocol 1.0–1.2 operations omit it and compile exactly
   * the legacy 1.1 plan; a 1.3 operation resolves the 1.3 definitions and
   * emits a Protocol 1.3 CapabilityPlan revision when — and only when — the
   * parallel_task_execution module actually participates.
   */
  readonly protocol_version?: "1.1.0" | "1.3.0";
}

/**
 * Operation-scope model slots and the capability that makes a domain slot
 * applicable (model advisory 11.2). Capture-scope slots (`project_discovery`,
 * Capture-stage `approval_brief`) never appear here; they are held by the
 * ProfileDecision-level Capture-scope binding record.
 */
const OPERATION_SCOPE_SLOTS: readonly {
  readonly slot_id: ModelSlotId;
  readonly purpose?: GroundedSynthesisPurpose;
  readonly requires_capability?: CapabilityId;
}[] = [
  { slot_id: "impact_advisory", requires_capability: "impact_analysis" },
  { slot_id: "design_review", requires_capability: "design_governance" },
  { slot_id: "plan_proposal" },
  { slot_id: "feedback_analysis" },
  { slot_id: "grounded_synthesis", purpose: "context_enrichment" },
  { slot_id: "grounded_synthesis", purpose: "iteration_narrative" },
];

interface ResolvedCapability {
  readonly resolution: CapabilityResolutionEntry["resolution"];
  readonly resolution_source: CapabilityResolutionSource;
  readonly binding_digest: string;
}

function isProviderCapability(value: string): value is ProviderCapability {
  return (PROVIDER_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Mode lookup over a versioned profile definition. The id list always comes
 * from the same protocol version as the definition, so a missing mode means
 * registry drift — fail closed instead of reading it as conditional.
 */
function profileCapabilityMode(
  definition: ProfileDefinition,
  capabilityId: CapabilityIdV13,
): CapabilityMode {
  const mode = (definition.capabilities as Readonly<Record<string, CapabilityMode>>)[capabilityId];
  if (mode === undefined) {
    throw new CapabilityCompileError(
      "unknown_capability",
      `profile ${definition.profile_id} (${definition.protocol_version}) has no mode for ${capabilityId}`,
    );
  }
  return mode;
}

function resolveCapabilities(
  input: CapabilityPlanCompileInput,
  profileId: ProfileId,
  protocolVersion: "1.1.0" | "1.3.0",
): Map<CapabilityIdV13, ResolvedCapability> {
  const definition = profileDefinitionForProtocol(
    profileId,
    profileDefinitionVersionForProtocol(protocolVersion),
  );
  const policy = input.policy;
  const activations = new Map<CapabilityIdV13, CapabilityActivation>();
  for (const activation of input.activations ?? []) {
    // Unknown capabilities fail closed via the registry lookup.
    capabilityModuleDefinition(activation.capability_id, protocolVersion);
    activations.set(activation.capability_id, activation);
  }

  const deniedCapabilities = policy?.denied_capabilities as readonly string[] | undefined;
  const requiredCapabilities = policy?.required_capabilities as readonly string[] | undefined;

  const resolved = new Map<CapabilityIdV13, ResolvedCapability>();
  for (const capabilityId of registeredCapabilityIds(protocolVersion)) {
    const mode = profileCapabilityMode(definition, capabilityId);
    const denied = deniedCapabilities?.includes(capabilityId) ?? false;
    const policyRequired = requiredCapabilities?.includes(capabilityId) ?? false;
    const activation = activations.get(capabilityId);

    if (denied && mode === "required") {
      throw new CapabilityCompileError(
        "policy_conflict",
        `policy denies ${capabilityId} but profile ${profileId} requires it`,
      );
    }
    if (denied && activation !== undefined) {
      throw new CapabilityCompileError(
        "policy_deny_not_overridable",
        `policy denies ${capabilityId}; no activation can override a policy deny`,
      );
    }

    if (denied) {
      resolved.set(capabilityId, {
        resolution: "inactive_by_profile",
        resolution_source: "policy_denied",
        binding_digest: input.policy_digest,
      });
      continue;
    }
    if (mode === "required") {
      resolved.set(capabilityId, {
        resolution: "active",
        resolution_source: "profile_required",
        binding_digest: definition.definition_digest,
      });
      continue;
    }
    if (profileId === "standard" && capabilityId === "strict_tdd" && mode === "conditional") {
      // The only legal deferred point in protocol 1.1 (design 8.4, 9.3):
      // Standard strict_tdd resolves exclusively behind the accepted
      // DesignSet — neither activation nor policy can skip the two-phase
      // boundary, because the test_strategy decides task-level applicability.
      resolved.set(capabilityId, {
        resolution: "deferred",
        resolution_source: "awaiting_design_set",
        binding_digest: definition.definition_digest,
      });
      continue;
    }
    if (policyRequired) {
      resolved.set(capabilityId, {
        resolution: "active",
        resolution_source: "policy_required",
        binding_digest: input.policy_digest,
      });
      continue;
    }
    if (activation !== undefined && mode !== "disabled") {
      resolved.set(capabilityId, {
        resolution: "active",
        resolution_source: activation.source,
        binding_digest:
          activation.binding_digest ??
          (activation.source === "risk_activation"
            ? input.risk_digest
            : input.profile_decision.record_digest),
      });
      continue;
    }
    resolved.set(capabilityId, {
      resolution: "inactive_by_profile",
      resolution_source: "conditional_inactive",
      binding_digest: definition.definition_digest,
    });
  }
  return resolved;
}

function compileModelProviderBindings(
  input: CapabilityPlanCompileInput,
  profileId: ProfileId,
  active: ReadonlySet<CapabilityIdV13>,
): ModelProviderBinding[] {
  const defaults = new Map(
    modelSlotDefaultsForProfile(profileId).map((slot) => [bindingScopeKey(slot), slot]),
  );

  // Contract fields are always derived from the injected resolver; a config
  // carrying them by hand fails closed before any resolution happens.
  const handSuppliedFields = [
    "prompt_contract_id",
    "prompt_contract_version",
    "prompt_contract_digest",
    "output_schema_digest",
  ] as const;

  // Validate and index every offered config first, fail closed.
  const configs = new Map<string, ModelProviderConfig>();
  for (const config of input.model_providers ?? []) {
    for (const field of handSuppliedFields) {
      if (field in config) {
        throw new CapabilityCompileError(
          "prompt_contract_digest_mismatch",
          `contract field ${field} is derived from the PromptContractRegistry; it must not be hand-filled`,
        );
      }
    }
    if (!(MODEL_SLOT_IDS as readonly string[]).includes(config.slot_id)) {
      throw new CapabilityCompileError(
        "unknown_slot",
        `unknown model slot: ${String(config.slot_id)}`,
      );
    }
    if (config.slot_id === "grounded_synthesis") {
      if (
        config.purpose === undefined ||
        !(GROUNDED_SYNTHESIS_PURPOSES as readonly string[]).includes(config.purpose)
      ) {
        throw new CapabilityCompileError(
          "unknown_purpose",
          `unknown grounded synthesis purpose: ${String(config.purpose)}`,
        );
      }
    } else if (config.purpose !== undefined) {
      throw new CapabilityCompileError(
        "unexpected_purpose",
        `domain slot ${config.slot_id} takes no grounded synthesis purpose`,
      );
    }
    if (isCaptureScopeBinding(config)) {
      throw new CapabilityCompileError(
        "capture_scope_slot",
        `slot/purpose ${bindingScopeKey(config)} belongs to the capture scope and never enters the capability plan`,
      );
    }
    const key = bindingScopeKey(config);
    if (configs.has(key)) {
      throw new CapabilityCompileError(
        "provider_config_conflict",
        `conflicting provider configs for slot/purpose ${key}`,
      );
    }
    configs.set(key, config);
  }

  const bindings: ModelProviderBinding[] = [];
  const consumed = new Set<string>();
  for (const slot of OPERATION_SCOPE_SLOTS) {
    const key = bindingScopeKey(slot);
    const applicable =
      slot.requires_capability === undefined || active.has(slot.requires_capability);
    if (!applicable) continue;
    const slotDefault = defaults.get(key);
    if (slotDefault === undefined) {
      throw new CapabilityCompileError("unknown_slot", `no profile default for slot ${key}`);
    }
    // Lite: a domain slot becomes mandatory once its capability is activated
    // (model advisory 11.2); purely optional slots bind only when configured.
    const liteActivated =
      profileId === "lite" &&
      slot.requires_capability !== undefined &&
      active.has(slot.requires_capability);
    const required = slotDefault.required || liteActivated;
    const config = configs.get(key);
    if (config === undefined) {
      if (required) {
        throw new CapabilityCompileError(
          "missing_model_provider",
          `required model slot ${key} has no provider configuration`,
        );
      }
      continue;
    }
    if (config.failure_mode !== undefined && config.failure_mode !== slotDefault.failure_mode) {
      throw new CapabilityCompileError(
        "invalid_failure_mode",
        `slot ${key} must use failure mode ${slotDefault.failure_mode} on profile ${profileId}`,
      );
    }
    consumed.add(key);
    const resolver = input.prompt_contract_resolver;
    if (resolver === undefined) {
      throw new CapabilityCompileError(
        "prompt_contract_required",
        `slot ${key} compiles a model provider binding but no prompt contract resolver was injected`,
      );
    }
    let resolution;
    try {
      resolution = resolver.resolve({
        port_id: config.slot_id,
        ...(config.purpose === undefined ? {} : { purpose: config.purpose }),
        prompt_version: config.prompt_version,
      });
    } catch (error) {
      if (error instanceof PromptContractError) {
        throw new CapabilityCompileError(error.code, error.message);
      }
      throw error;
    }
    bindings.push({
      slot_id: config.slot_id,
      ...(config.purpose === undefined ? {} : { purpose: config.purpose }),
      required,
      provider_identity: config.provider_identity,
      config_digest: config.config_digest,
      prompt_version: config.prompt_version,
      prompt_contract_id: resolution.prompt_contract_id,
      prompt_contract_version: resolution.prompt_contract_version,
      prompt_contract_digest: resolution.prompt_contract_digest,
      output_schema_digest: resolution.output_schema_digest,
      schema_version: config.schema_version,
      budget_profile: config.budget_profile,
      failure_mode: slotDefault.failure_mode,
    });
  }
  for (const key of configs.keys()) {
    if (!consumed.has(key)) {
      throw new CapabilityCompileError(
        "slot_not_applicable",
        `provider config for ${key}, which is not applicable to this operation`,
      );
    }
  }

  const sorted = bindings.sort((left, right) =>
    bindingScopeKey(left) < bindingScopeKey(right) ? -1 : 1,
  );
  // Deterministic scope-overlap check: a slot/purpose held by the
  // Capture-scope record can never reappear in the CapabilityPlan.
  assertBindingScopesDisjoint(input.capture_scope_bindings ?? [], sorted);
  return sorted;
}

function compileInvalidationGraph(
  active: ReadonlySet<CapabilityIdV13>,
  protocolVersion: "1.1.0" | "1.3.0",
): InvalidationEdgeV13[] {
  const edges = new Map<string, CapabilityIdV13[]>();
  for (const capabilityId of active) {
    const module = capabilityModuleDefinition(capabilityId, protocolVersion);
    for (const bindingKind of module.invalidated_by) {
      edges.set(bindingKind, [...(edges.get(bindingKind) ?? []), capabilityId]);
    }
  }
  return [...edges.entries()]
    .map(([bindingKind, invalidates]) => ({
      binding_kind: bindingKind as InvalidationEdgeV13["binding_kind"],
      invalidates: [...invalidates].sort(),
    }))
    .sort((left, right) => (left.binding_kind < right.binding_kind ? -1 : 1));
}

/**
 * Compile one CapabilityPlan revision. Standard resolves strict_tdd in two
 * stages: provisional defers it until the accepted DesignSet, final binds the
 * test_strategy digest in one superseding revision (design 9.3). Protocol 1.3
 * operations (M4 design 10.2) resolve the 1.3 definition set and emit a 1.3
 * revision exactly when the parallel_task_execution module participates; a
 * 1.3 operation with the module disabled keeps the byte-compatible 1.1 shape
 * so sequential execution and legacy readers never see a 1.3 record.
 */
export function compileCapabilityPlan(
  input: CapabilityPlanCompileInput & { protocol_version?: "1.1.0" },
): CapabilityPlanRecord;
export function compileCapabilityPlan(input: CapabilityPlanCompileInput): AnyCapabilityPlanRecord;
export function compileCapabilityPlan(input: CapabilityPlanCompileInput): AnyCapabilityPlanRecord {
  const protocolVersion = input.protocol_version ?? PROTOCOL_1_1_VERSION;
  const profileId = input.project_profile.profile_id;
  if (input.stage === "provisional" && profileId !== "standard") {
    throw new CapabilityCompileError(
      "illegal_provisional_stage",
      `profile ${profileId} has no legal deferred capability; compile final directly`,
    );
  }

  const supersedes = input.supersedes;
  if (input.stage === "final" && profileId === "standard" && supersedes === undefined) {
    throw new CapabilityCompileError(
      "provisional_required",
      "standard finalization must supersede its provisional revision",
    );
  }
  if (supersedes !== undefined) {
    const mismatches: string[] = [];
    if (supersedes.compilation_stage !== "provisional") mismatches.push("compilation_stage");
    if (supersedes.operation_id !== input.operation_id) mismatches.push("operation_id");
    if (supersedes.profile_id !== profileId) mismatches.push("profile_id");
    if (supersedes.project_profile_digest !== input.project_profile.record_digest) {
      mismatches.push("project_profile_digest");
    }
    if (supersedes.profile_decision_digest !== input.profile_decision.record_digest) {
      mismatches.push("profile_decision_digest");
    }
    if (supersedes.requirement_digest !== input.requirement_digest) {
      mismatches.push("requirement_digest");
    }
    if (supersedes.risk_digest !== input.risk_digest) mismatches.push("risk_digest");
    if (supersedes.policy_digest !== input.policy_digest) mismatches.push("policy_digest");
    if (supersedes.baseline_digest !== input.baseline_digest) {
      mismatches.push("baseline_digest");
    }
    if (mismatches.length > 0) {
      throw new CapabilityCompileError(
        "supersede_mismatch",
        `final revision drifted from the provisional on: ${mismatches.sort().join(", ")}`,
      );
    }
  }

  const resolved = resolveCapabilities(input, profileId, protocolVersion);

  // Standard strict_tdd finalization is the declared deferred boundary: it is
  // the only resolution allowed to consume a future artifact, and only once
  // the DesignSet is accepted (design 9.3).
  const strictTdd = resolved.get("strict_tdd");
  if (input.stage === "final" && profileId === "standard" && strictTdd !== undefined) {
    if (strictTdd.resolution !== "inactive_by_profile") {
      if (input.accepted_design_set === undefined) {
        throw new CapabilityCompileError(
          "design_set_required",
          "standard finalization requires the accepted design set and test strategy",
        );
      }
      resolved.set("strict_tdd", {
        resolution: "active",
        resolution_source: "design_set_finalization",
        binding_digest: input.accepted_design_set.test_strategy_digest,
      });
    }
  }

  // No deferred resolution may survive outside the one declared point.
  for (const [capabilityId, entry] of resolved) {
    if (entry.resolution !== "deferred") continue;
    const legal =
      input.stage === "provisional" && profileId === "standard" && capabilityId === "strict_tdd";
    if (!legal) {
      throw new CapabilityCompileError(
        "illegal_deferred",
        `capability ${capabilityId} may not be deferred here`,
      );
    }
  }

  // Dependency closure: activated capabilities drag their dependencies in.
  const directlyActive = [...resolved.entries()]
    .filter(([, entry]) => entry.resolution === "active")
    .map(([capabilityId]) => capabilityId);
  const closure = capabilityDependencyClosure(directlyActive, protocolVersion);
  const active = new Set(closure);
  const definition = profileDefinitionForProtocol(
    profileId,
    profileDefinitionVersionForProtocol(protocolVersion),
  );
  for (const capabilityId of closure) {
    const entry = resolved.get(capabilityId);
    if (entry !== undefined && entry.resolution !== "active") {
      resolved.set(capabilityId, {
        resolution: "active",
        resolution_source: "dependency_closure",
        binding_digest: definition.definition_digest,
      });
    }
  }

  // The emitted record version follows participation (M4 design 10.2): only a
  // 1.3 operation with an active parallel module produces a 1.3 revision.
  const emitVersion =
    protocolVersion === PROTOCOL_1_3_VERSION && active.has("parallel_task_execution")
      ? PROTOCOL_1_3_VERSION
      : PROTOCOL_1_1_VERSION;

  // Provider closure: required providers of every active module must exist.
  const requiredProviders = new Set<ProviderCapability>();
  for (const capabilityId of active) {
    for (const provider of capabilityModuleDefinition(capabilityId, emitVersion)
      .required_providers) {
      requiredProviders.add(provider);
    }
  }
  const provided = new Set<string>(input.providers ?? []);
  for (const provider of provided) {
    if (!isProviderCapability(provider)) {
      throw new CapabilityCompileError(
        "unknown_provider",
        `unknown provider capability: ${provider}`,
      );
    }
  }
  const missingProviders = [...requiredProviders].filter((provider) => !provided.has(provider));
  if (missingProviders.length > 0) {
    throw new CapabilityCompileError(
      "missing_provider",
      `missing required providers: ${missingProviders.sort().join(", ")}`,
    );
  }

  const bindings = compileModelProviderBindings(input, profileId, active);

  const dag = buildOperationDag(active, emitVersion);
  validateOperationDag(dag);
  // The record schema owns mutable arrays; copy the readonly DAG nodes once.
  const dagNodes = dag.map((node) => ({
    ...node,
    depends_on: [...node.depends_on],
    consumes: [...node.consumes],
    produces: [...node.produces],
  }));

  const approvalObjects = canonicalStringSet([
    "project_profile",
    "requirement_baseline",
    ...[...active].flatMap((capabilityId) => [
      ...capabilityModuleDefinition(capabilityId, emitVersion).approval_objects,
    ]),
  ]) as ApprovalObjectKind[];

  const revision = supersedes === undefined ? 1 : supersedes.revision + 1;
  // A 1.1 revision carries exactly the legacy five resolution entries; the
  // 1.3 vocabulary appears only in a 1.3 revision.
  const emittedIds = new Set<string>(registeredCapabilityIds(emitVersion));
  const capabilities: CapabilityResolutionEntryV13[] = [...resolved.entries()]
    .filter(([capabilityId]) => emittedIds.has(capabilityId))
    .map(([capabilityId, entry]) => {
      const module = capabilityModuleDefinition(capabilityId, emitVersion);
      return {
        capability_id: capabilityId,
        resolution: entry.resolution,
        resolution_source: entry.resolution_source,
        module_version: module.version,
        module_digest: module.definition_digest,
        binding_digest: entry.binding_digest,
      };
    });

  const record = sealRecordEnvelope({
    protocol_version: emitVersion,
    record_kind: "capability_plan" as const,
    capability_plan_id: domainRecordId({
      domain_tag: "capability_plan",
      id_prefix: "capability-plan",
      protocol_version: emitVersion,
      canonical_input: { operation_id: input.operation_id, revision },
    }),
    operation_id: input.operation_id,
    revision,
    compilation_stage: input.stage,
    profile_id: profileId,
    project_profile_digest: input.project_profile.record_digest,
    profile_decision_digest: input.profile_decision.record_digest,
    requirement_digest: input.requirement_digest,
    risk_digest: input.risk_digest,
    policy_digest: input.policy_digest,
    baseline_digest: input.baseline_digest,
    capabilities,
    providers: [...requiredProviders].sort(),
    approval_policy_id: definition.approval_policy_id,
    approval_objects: approvalObjects,
    operation_dag: { nodes: dagNodes },
    invalidation_graph: compileInvalidationGraph(active, emitVersion),
    model_provider_bindings: bindings,
    ...(input.stage === "final" && input.accepted_design_set !== undefined
      ? {
          design_set_digest: input.accepted_design_set.design_set_digest,
          test_strategy_digest: input.accepted_design_set.test_strategy_digest,
        }
      : {}),
    ...(supersedes === undefined ? {} : { supersedes_digest: supersedes.record_digest }),
  });
  // The emitted version is data-dependent (see emitVersion above), so the
  // static record type is pinned by the overloads; schema validation of both
  // shapes is covered by the capability test suites.
  return record as AnyCapabilityPlanRecord;
}

/**
 * The execution gate: only a final plan with no deferred resolutions may
 * enter the Plan stage (design 8.4 — provisional grants no execution
 * authorization).
 */
export function assertCapabilityPlanFinal(plan: AnyCapabilityPlanRecord): void {
  const deferred = plan.capabilities.filter((entry) => entry.resolution === "deferred");
  if (plan.compilation_stage !== "final" || deferred.length > 0) {
    throw new CapabilityCompileError(
      "plan_not_final",
      `capability plan revision ${plan.revision} is ${plan.compilation_stage}; only a final plan may enter plan`,
    );
  }
}

/** Read API helper: the compiled resolution of one capability. */
export function capabilityResolution(
  plan: AnyCapabilityPlanRecord,
  capabilityId: CapabilityIdV13,
): CapabilityResolutionEntry | CapabilityResolutionEntryV13 {
  capabilityModuleDefinition(capabilityId, plan.protocol_version);
  const entry = plan.capabilities.find((candidate) => candidate.capability_id === capabilityId);
  if (entry === undefined) {
    throw new CapabilityCompileError(
      "unknown_capability",
      `capability plan does not resolve ${capabilityId}`,
    );
  }
  return entry;
}

/**
 * Transitive invalidation (design 9.2): a drifted binding invalidates its
 * direct consumers and everything depending on them downstream.
 */
export function invalidatedCapabilities(
  plan: AnyCapabilityPlanRecord,
  bindingKind: string,
): CapabilityIdV13[] {
  const invalidated = new Set<CapabilityIdV13>(
    plan.invalidation_graph
      .filter((edge) => edge.binding_kind === bindingKind)
      .flatMap((edge) => [...edge.invalidates]),
  );
  const activeIds = plan.capabilities
    .filter((entry) => entry.resolution === "active")
    .map((entry) => entry.capability_id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const capabilityId of activeIds) {
      if (invalidated.has(capabilityId)) continue;
      const dependsOn = capabilityModuleDefinition(capabilityId, plan.protocol_version).depends_on;
      if (dependsOn.some((dependency) => invalidated.has(dependency))) {
        invalidated.add(capabilityId);
        changed = true;
      }
    }
  }
  return [...invalidated].sort();
}

export type { OperationDagNode };
