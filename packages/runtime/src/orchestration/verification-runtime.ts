/** Immutable verification result consumed by resume and Snapshot. */
export interface VerifyPhaseArtifact {
  readonly record_kind: "orchestration_verify_result";
  readonly iteration_id: string;
  readonly bindings: {
    readonly artifact_digests: readonly string[];
    readonly code_digests: readonly string[];
    readonly context_bundle_digest?: string;
    readonly evaluation_case_digests: readonly string[];
    readonly policy_digest: string;
  };
  readonly results: readonly {
    readonly gate_id: string;
    readonly passed: boolean;
    readonly evidence_id: string;
    readonly summary: string;
  }[];
  readonly findings: readonly { readonly id: string; readonly summary: string }[];
  readonly completed_allowed: boolean;
}

/** Exact replay identity: no unordered or partial binding comparison. */
export function verificationBindingsEqual(
  left: VerifyPhaseArtifact["bindings"],
  right: VerifyPhaseArtifact["bindings"],
): boolean {
  return (
    JSON.stringify(left.artifact_digests) === JSON.stringify(right.artifact_digests) &&
    JSON.stringify(left.code_digests) === JSON.stringify(right.code_digests) &&
    left.context_bundle_digest === right.context_bundle_digest &&
    JSON.stringify(left.evaluation_case_digests) ===
      JSON.stringify(right.evaluation_case_digests) &&
    left.policy_digest === right.policy_digest
  );
}
