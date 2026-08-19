import {
  GROUNDED_SYNTHESIS_PURPOSES,
  type GroundedSynthesisPurpose,
  type ModelBindingFailureMode,
  type ModelSlotId,
  type ProfileId,
} from "../schema/profile.js";

/**
 * Model slot defaults per profile tier (model advisory design 11.2). The
 * matrix decides whether a slot is required and how its failure surfaces;
 * provider identity, config and prompt/schema versions are bound later by
 * Capture-scope records (Task 2) or CapabilityPlan bindings (Task 3).
 */
export interface ModelSlotDefault {
  readonly slot_id: ModelSlotId;
  readonly purpose?: GroundedSynthesisPurpose;
  readonly required: boolean;
  readonly failure_mode: ModelBindingFailureMode;
}

export interface CaptureScopeSlot {
  readonly slot_id: "grounded_synthesis";
  readonly purpose: "project_discovery" | "approval_brief";
}

/**
 * The slots that run before the CapabilityPlan exists; their bindings are
 * held by the ProfileDecision-level Capture-scope record (design 11.1).
 */
export const CAPTURE_SCOPE_SLOTS: readonly CaptureScopeSlot[] = [
  { slot_id: "grounded_synthesis", purpose: "approval_brief" },
  { slot_id: "grounded_synthesis", purpose: "project_discovery" },
];

export class BindingScopeError extends Error {
  readonly kind = "binding_scope_overlap" as const;
  readonly overlaps: readonly string[];

  constructor(overlaps: readonly string[]) {
    super(`slot/purpose held by both capture and operation scopes: ${overlaps.join(", ")}`);
    this.name = "BindingScopeError";
    this.overlaps = overlaps;
  }
}

/** Stable scope identity of one binding: `<slot_id>:<purpose?>`. */
export function bindingScopeKey(binding: {
  readonly slot_id: string;
  readonly purpose?: string;
}): string {
  return `${binding.slot_id}:${binding.purpose ?? ""}`;
}

/**
 * Deterministic scope-overlap check (design 11.1): a slot/purpose may live in
 * the Capture-scope record or in the CapabilityPlan bindings, never both.
 */
export function assertBindingScopesDisjoint(
  captureScope: ReadonlyArray<{ readonly slot_id: string; readonly purpose?: string }>,
  operationScope: ReadonlyArray<{ readonly slot_id: string; readonly purpose?: string }>,
): void {
  const captureKeys = new Set(captureScope.map((binding) => bindingScopeKey(binding)));
  const overlaps = [
    ...new Set(
      operationScope
        .map((binding) => bindingScopeKey(binding))
        .filter((key) => captureKeys.has(key)),
    ),
  ].sort();
  if (overlaps.length > 0) {
    throw new BindingScopeError(overlaps);
  }
}

type SlotKey = `${ModelSlotId}:${GroundedSynthesisPurpose | ""}`;

const DOMAIN_SLOTS: readonly ModelSlotId[] = [
  "impact_advisory",
  "design_review",
  "plan_proposal",
  "feedback_analysis",
];

/**
 * The 11.2 matrix. `required` follows the tier; `iteration_narrative` is the
 * sole non-blocking slot — its failure may only ever raise a recoverable
 * projection finding, never block the Snapshot.
 */
const PROFILE_SLOT_MATRIX: Record<ProfileId, Record<SlotKey, ModelSlotDefault>> = {
  lite: buildTier({ domainRequired: false, groundedRequired: false }),
  standard: buildTier({ domainRequired: true, groundedRequired: true }),
  governed: buildTier({ domainRequired: true, groundedRequired: true }),
};

function buildTier(options: {
  readonly domainRequired: boolean;
  readonly groundedRequired: boolean;
}): Record<SlotKey, ModelSlotDefault> {
  const entries: ModelSlotDefault[] = [
    ...DOMAIN_SLOTS.map((slotId): ModelSlotDefault => ({
      slot_id: slotId,
      required: options.domainRequired,
      failure_mode: "block",
    })),
    ...GROUNDED_SYNTHESIS_PURPOSES.map((purpose): ModelSlotDefault => ({
      slot_id: "grounded_synthesis",
      purpose,
      required: options.groundedRequired,
      failure_mode: purpose === "iteration_narrative" ? "projection_finding" : "block",
    })),
  ];
  return Object.fromEntries(entries.map((entry) => [bindingScopeKey(entry), entry])) as Record<
    SlotKey,
    ModelSlotDefault
  >;
}

/** The eight slot defaults of one tier, sorted by canonical scope key. */
export function modelSlotDefaultsForProfile(profileId: ProfileId): readonly ModelSlotDefault[] {
  return Object.values(PROFILE_SLOT_MATRIX[profileId]).sort((left, right) =>
    bindingScopeKey(left) < bindingScopeKey(right) ? -1 : 1,
  );
}

/** Whether a binding belongs to the Capture scope (design 11.1). */
export function isCaptureScopeBinding(binding: {
  readonly slot_id: string;
  readonly purpose?: string;
}): boolean {
  return CAPTURE_SCOPE_SLOTS.some(
    (slot) => slot.slot_id === binding.slot_id && slot.purpose === binding.purpose,
  );
}
