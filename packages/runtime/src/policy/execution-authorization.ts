import { PROTOCOL_VERSION, contentDigest, validateSchema } from "@universal-harness-internal/core";

import type { GovernanceRisk } from "../planning/effective-risk.js";

export interface ExecutionAuthorizationSpec {
  readonly authorization_id: string;
  readonly iteration_id: string;
  readonly plan_digest: string;
  readonly task_digests: readonly string[];
  readonly impact_set_digest: string;
  readonly impact_coverage_digest: string;
  readonly context_bundle_digests: readonly string[];
  readonly grant_spec_digests: readonly string[];
  readonly policy_digest: string;
  readonly adapter_profile_digest?: string;
  readonly baseline_commit: string;
  readonly effective_risk: GovernanceRisk;
  readonly spec_digest: string;
}

export interface ExecutionAuthorizationRecord extends Omit<
  ExecutionAuthorizationSpec,
  "spec_digest"
> {
  readonly protocol_version: string;
  readonly record_kind: "execution_authorization";
  readonly approval_digest: string;
  readonly digest: string;
  readonly extensions: {
    readonly "harness.authorization": {
      readonly spec_digest: string;
      readonly supervised: boolean;
    };
  };
}

export function authorizationSpecDigest(
  spec: Omit<ExecutionAuthorizationSpec, "spec_digest">,
): string {
  return contentDigest(spec);
}

export function buildExecutionAuthorizationRecord(
  spec: ExecutionAuthorizationSpec,
  approvalDigest: string,
  supervised: boolean,
): ExecutionAuthorizationRecord {
  const { spec_digest: specDigest, ...authorized } = spec;
  const base = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "execution_authorization" as const,
    ...authorized,
    approval_digest: approvalDigest,
    extensions: { "harness.authorization": { spec_digest: specDigest, supervised } },
  };
  const record = { ...base, digest: contentDigest(base) };
  const validation = validateSchema("runtime", record);
  if (!validation.valid) {
    throw new Error(
      `invalid execution authorization record: ${validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  return record;
}
