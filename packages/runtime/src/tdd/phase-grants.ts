import { contentDigest, type TddPathPolicy } from "@universal-harness-internal/core";

import { issueGrant, type CapabilityGrant, type GrantBudget } from "../policy/capability-grant.js";
import { type EffectivePolicy } from "../policy/decision.js";

/**
 * TDD phase grants (provable TDD design 8.3, plan T15): every phase of the
 * TDD state machine runs under its own digest-bound CapabilityGrant —
 * capability is never widened on an existing grant. Implementation unlocks
 * only behind an accepted Red proof, refactor behind Green; agent
 * self-reports, transcripts and live events unlock nothing. A resume
 * re-issue is the identical grant (never a duplicate ledger fact), and a
 * grant used outside its phase or against a drifted policy fails closed.
 */
export class TddGrantError extends Error {
  readonly kind: "missing_precondition" | "grant_drift";

  constructor(kind: "missing_precondition" | "grant_drift", message: string) {
    super(message);
    this.name = "TddGrantError";
    this.kind = kind;
  }
}

export type TddPhaseGrantState =
  "baseline_guard" | "test_authoring" | "red_verification" | "implementation" | "refactor";

/** The write scope each phase may hold (design 8.3 table). */
export function tddPhaseWriteScopes(
  state: TddPhaseGrantState,
  policy: TddPathPolicy,
): readonly string[] {
  switch (state) {
    case "baseline_guard":
    case "red_verification":
      return [];
    case "test_authoring":
      return [...policy.test, ...policy.test_config].sort();
    case "implementation":
    case "refactor":
      return [...policy.production].sort();
  }
}

function grantIdFor(
  taskId: string,
  state: TddPhaseGrantState,
  writeScopes: readonly string[],
): string {
  return `tdd-grant_${contentDigest({ task_id: taskId, state, write_paths: [...writeScopes] }).slice(0, 16)}`;
}

/** Phases whose grant requires an accepted proof of the previous phase. */
const PROOF_GATED: Readonly<Record<string, string>> = {
  implementation: "an accepted RedEvidence digest",
  refactor: "an accepted GreenEvidence digest",
};

export function issueTddPhaseGrant(
  input: {
    readonly state: TddPhaseGrantState;
    readonly task_id: string;
    readonly policy: TddPathPolicy;
    readonly budget: GrantBudget;
    readonly effective: EffectivePolicy;
    readonly approval_digests?: readonly string[];
    /** Accepted proof unlocking proof-gated phases (Red for implementation, Green for refactor). */
    readonly proof_digest?: string;
  },
  existing: readonly CapabilityGrant[],
): { readonly grant: CapabilityGrant; readonly reused: boolean } {
  const requirement = PROOF_GATED[input.state];
  if (requirement !== undefined && input.proof_digest === undefined) {
    throw new TddGrantError("missing_precondition", `${input.state} grant requires ${requirement}`);
  }
  const writeScopes = tddPhaseWriteScopes(input.state, input.policy);
  const grantId = grantIdFor(input.task_id, input.state, writeScopes);
  const reuse = existing.find((grant) => grant.grant_id === grantId);
  if (reuse !== undefined) {
    return { grant: reuse, reused: true };
  }
  const grant = issueGrant(
    {
      grant_id: grantId,
      task_id: input.task_id,
      capabilities: [],
      read_paths: [
        ...input.policy.test,
        ...input.policy.test_config,
        ...input.policy.production,
      ].sort(),
      write_paths: writeScopes,
      tools: [],
      phase: input.state,
      budget: input.budget,
      ...(input.approval_digests === undefined ? {} : { approval_digests: input.approval_digests }),
    },
    input.effective,
  );
  return { grant, reused: false };
}

/** A grant is usable only for its own phase, task and path policy. */
export function assertTddPhaseGrantCurrent(
  grant: CapabilityGrant,
  expected: {
    readonly state: TddPhaseGrantState;
    readonly task_id: string;
    readonly policy: TddPathPolicy;
  },
): void {
  const expectedId = grantIdFor(
    expected.task_id,
    expected.state,
    tddPhaseWriteScopes(expected.state, expected.policy),
  );
  if (grant.grant_id !== expectedId || grant.task_id !== expected.task_id) {
    throw new TddGrantError(
      "grant_drift",
      `grant ${grant.grant_id} does not bind phase ${expected.state} of task ${expected.task_id}`,
    );
  }
}
