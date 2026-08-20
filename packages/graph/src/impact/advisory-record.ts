import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  PROTOCOL_1_1_VERSION,
  contentDigest,
  domainRecordId,
  sealRecordEnvelope,
  type ImpactAdvisoryOutput,
  type ImpactAdvisoryRecord,
} from "@universal-harness-internal/core";

import { RELATION_RULE_REGISTRY } from "./advisory.js";
import { ImpactError } from "./seeds.js";

/**
 * ImpactAdvisoryRecord factory (model advisory design 5.3, PG-3). The record
 * pins the advised set, the shipped relation rule registry version/digest and
 * the binding/conversation/run identity; invocation provenance stays in the
 * ModelInvocationRecord. The factory seals the envelope and validates against
 * the registered `impact-advisory` schema, so a record that cannot validate
 * never exists.
 */
export function createImpactAdvisoryRecord(input: {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly impact_set_digest: string;
  /** Digest of the provider/contract binding the advisory ran under. */
  readonly binding_digest: string;
  readonly conversation_id: string;
  readonly run_id: string;
  /** Digest of the canonical advisory input the model was bound to. */
  readonly input_digest: string;
  readonly output: ImpactAdvisoryOutput;
}): ImpactAdvisoryRecord {
  const record = sealRecordEnvelope({
    protocol_version: PROTOCOL_1_1_VERSION,
    record_kind: "impact_advisory" as const,
    impact_advisory_id: domainRecordId({
      domain_tag: "impact_advisory",
      id_prefix: "impact-advisory",
      protocol_version: PROTOCOL_1_1_VERSION,
      canonical_input: {
        impact_set_digest: input.impact_set_digest,
        input_digest: input.input_digest,
        output_digest: contentDigest(input.output),
      },
    }),
    workflow_operation_id: input.workflow_operation_id,
    iteration_id: input.iteration_id,
    impact_set_digest: input.impact_set_digest,
    relation_rule_registry_version: RELATION_RULE_REGISTRY.version,
    relation_rule_registry_digest: RELATION_RULE_REGISTRY.digest,
    binding_digest: input.binding_digest,
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    input_digest: input.input_digest,
    output: input.output,
  });
  const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("impact-advisory", record);
  if (!validation.valid) {
    throw new ImpactError(
      `invalid impact advisory record: ${validation.errors
        .map((issue) => `${issue.instancePath}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return record;
}
