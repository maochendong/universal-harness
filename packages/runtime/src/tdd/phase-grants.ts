import { contentDigest, type TddPathPolicy } from "@universal-harness-internal/core";

import { issueGrant, type CapabilityGrant, type GrantBudget } from "../policy/capability-grant.js";
import { type EffectivePolicy } from "../policy/decision.js";
import { tryNormalizeRepoRelativePath } from "../policy/path-boundary.js";

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

/** Canonical scope prefix: strips a trailing `/**`, rejects anything not repository-relative. */
function scopePrefix(scope: string): string | undefined {
  const bare = scope.endsWith("/**") ? scope.slice(0, -3) : scope;
  return tryNormalizeRepoRelativePath(bare);
}

function covers(ancestor: string, descendant: string): boolean {
  return descendant === ancestor || descendant.startsWith(`${ancestor}/`);
}

/**
 * True path-scope intersection (M4 design 12, plan Task 7 step 4) — never
 * string-array equality. A path survives iff every input set holds a scope
 * that covers it; the result is the canonical minimal set of scope prefixes
 * whose union is exactly that intersection. Any empty set, any
 * un-normalizable scope and any uncovered branch fail closed to `[]`.
 */
export function intersectWriteScopes(sets: readonly (readonly string[])[]): readonly string[] {
  const normalized = sets.map((scopes) => [
    ...new Set(scopes.map(scopePrefix).filter((scope): scope is string => scope !== undefined)),
  ]);
  if (normalized.some((set) => set.length === 0)) return [];
  const kept = new Set<string>();
  for (const set of normalized) {
    for (const scope of set) {
      // A scope is inside the intersection iff each set has a prefix of it:
      // for any path under the scope, that prefix witnesses coverage. The
      // converse holds because prefixes of one path are always nested, so
      // the longest witness of every set is itself covered by all of them.
      if (normalized.every((other) => other.some((candidate) => covers(candidate, scope)))) {
        kept.add(scope);
      }
    }
  }
  const sorted = [...kept].sort();
  return sorted.filter((scope) => !sorted.some((other) => other !== scope && covers(other, scope)));
}

/**
 * The effective write set of one Strict TDD phase execution (design 12):
 * Task.write_paths ∩ Task CapabilityGrant ∩ phase policy scopes ∩ PhaseGrant.
 * An empty result must block the phase before any execution.
 */
export function effectiveTddWriteScopes(input: {
  readonly task_write_paths: readonly string[];
  readonly task_grant_write_paths: readonly string[];
  readonly phase_policy_write_paths: readonly string[];
  readonly phase_grant_write_paths: readonly string[];
}): readonly string[] {
  return intersectWriteScopes([
    input.task_write_paths,
    input.task_grant_write_paths,
    input.phase_policy_write_paths,
    input.phase_grant_write_paths,
  ]);
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
