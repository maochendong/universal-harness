import type { PackPolicyField } from "@universal-harness-internal/plugin-sdk";

import { GENERIC_PACK } from "./pack.js";

/**
 * Generic Pack policy fields (design 13.3, plan Task 25 step 1): the approved
 * M1 LoopPolicy ceilings as `hard_ceiling` fields, so a project may lower them
 * freely but can never raise them through policy; repeat detection and
 * redaction defaults; the approval union and deny set every project starts
 * from. The fields merge field-by-field through the Policy schema operators,
 * never by whole-object override.
 */
export function genericPackPolicies(): readonly PackPolicyField[] {
  return GENERIC_PACK.policies;
}

/** Numeric value of a generic pack policy field, or undefined when absent. */
export function genericPackPolicyNumber(path: string): number | undefined {
  const field = GENERIC_PACK.policies.find((candidate) => candidate.path === path);
  return field !== undefined && typeof field.value === "number" ? field.value : undefined;
}
