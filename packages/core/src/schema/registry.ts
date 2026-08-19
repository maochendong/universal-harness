import type { ValidateFunction } from "ajv/dist/2020.js";
import type { TSchema } from "@sinclair/typebox";

import { isProtocolCompatible } from "../version.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";
import { createDomainSchemaRegistry, mergeSchemaDocuments } from "./domain-registry.js";
import { CapabilityPlanRecordSchema } from "./capability.js";
import {
  CaptureBlockerRecordSchema,
  CaptureCheckpointRecordSchema,
  CaptureInvocationRecordSchema,
  CaptureSessionRecordSchema,
  ClarificationAnswerRecordSchema,
  ClarificationQuestionRecordSchema,
} from "./capture.js";
import { EdgeSchema } from "./edge.js";
import { EventSchema } from "./event.js";
import { FeedbackSchema } from "./feedback.js";
import { NodeSchema } from "./node.js";
import { ObservationEventSchema } from "./observation.js";
import { LedgerOperationSchema, OperationSchema, WorkflowOperationSchema } from "./operation.js";
import { PluginManifestSchema } from "./plugin.js";
import {
  CaptureModelProviderBindingRecordSchema,
  ProfileDecisionRecordSchema,
  ProfileDefinitionSchema,
  ProfileRecommendationRecordSchema,
  ProjectProfileRecordSchema,
} from "./profile.js";
import { RuntimeSchema } from "./runtime.js";
import {
  compileAjvSchema,
  compileSchemaValidator,
  normalizeErrors,
  type CompiledSchemaValidator,
  type ValidationIssue,
  type ValidationResult,
} from "./validator.js";

export {
  compileSchemaValidator,
  type CompiledSchemaValidator,
  type ValidationIssue,
  type ValidationResult,
};

export const SCHEMA_KEYS = [
  "node",
  "edge",
  "event",
  "observation",
  "operation",
  "workflow-operation",
  "ledger-operation",
  "runtime",
  "feedback",
  "plugin",
] as const;

export type SchemaKey = (typeof SCHEMA_KEYS)[number];

export const SCHEMA_REGISTRY = {
  node: NodeSchema,
  edge: EdgeSchema,
  event: EventSchema,
  observation: ObservationEventSchema,
  operation: OperationSchema,
  "workflow-operation": WorkflowOperationSchema,
  "ledger-operation": LedgerOperationSchema,
  runtime: RuntimeSchema,
  feedback: FeedbackSchema,
  plugin: PluginManifestSchema,
} as const satisfies Record<SchemaKey, TSchema>;

const validators = new Map<SchemaKey, ValidateFunction>(
  SCHEMA_KEYS.map((key) => [key, compileAjvSchema(SCHEMA_REGISTRY[key])]),
);

function protocolVersionOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("protocol_version" in value)) {
    return undefined;
  }
  const protocolVersion = value.protocol_version;
  return typeof protocolVersion === "string" ? protocolVersion : undefined;
}

export function validateSchema(key: SchemaKey, value: unknown): ValidationResult {
  const validator = validators.get(key);
  if (validator === undefined) {
    return {
      valid: false,
      errors: [{ instancePath: "", keyword: "schema", message: `unknown schema: ${key}` }],
    };
  }

  if (!validator(value)) {
    return { valid: false, errors: normalizeErrors(validator.errors) };
  }

  if (key === "observation") {
    return { valid: true, errors: [] };
  }

  const protocolVersion = protocolVersionOf(value);
  if (protocolVersion === undefined || !isProtocolCompatible(protocolVersion)) {
    return {
      valid: false,
      errors: [
        {
          instancePath: "/protocol_version",
          keyword: "protocolCompatibility",
          message: `unsupported protocol version: ${protocolVersion ?? "missing"}`,
        },
      ],
    };
  }

  return { valid: true, errors: [] };
}

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

function schemaDocument(name: string, schema: TSchema): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      $schema: JSON_SCHEMA_DIALECT,
      $id: `https://schemas.universal-harness.dev/m1/${name}`,
      ...schema,
    }),
  ) as Record<string, unknown>;
}

export const JSON_SCHEMA_DOCUMENTS = Object.fromEntries(
  SCHEMA_KEYS.map((key) => [
    `${key}.schema.json`,
    schemaDocument(`${key}.schema.json`, SCHEMA_REGISTRY[key]),
  ]),
) as Record<string, Record<string, unknown>>;

/**
 * Protocol 1.1 domain schemas register here as their owning tasks land
 * (Profile T2, Capability T3, Capture T4-T7, and so on). Task 2 contributes
 * the profile definition and the Profile/Recommendation/Decision records plus
 * the Capture-scope model provider binding; Task 3 contributes the
 * CapabilityPlan record; Task 4 contributes the Capture session,
 * clarification, invocation, checkpoint and blocker records.
 */
export const PROTOCOL_1_1_SCHEMA_REGISTRY = createDomainSchemaRegistry({
  protocolVersion: PROTOCOL_1_1_VERSION,
  entries: [
    { key: "profile-definition", schema: ProfileDefinitionSchema },
    { key: "project-profile", schema: ProjectProfileRecordSchema },
    { key: "profile-recommendation", schema: ProfileRecommendationRecordSchema },
    { key: "profile-decision", schema: ProfileDecisionRecordSchema },
    { key: "model-provider-binding", schema: CaptureModelProviderBindingRecordSchema },
    { key: "capability-plan", schema: CapabilityPlanRecordSchema },
    { key: "capture-session", schema: CaptureSessionRecordSchema },
    { key: "clarification-question", schema: ClarificationQuestionRecordSchema },
    { key: "clarification-answer", schema: ClarificationAnswerRecordSchema },
    { key: "capture-invocation", schema: CaptureInvocationRecordSchema },
    { key: "capture-checkpoint", schema: CaptureCheckpointRecordSchema },
    { key: "capture-blocker", schema: CaptureBlockerRecordSchema },
  ],
});

/** Every document scripts/write-schemas.mjs persists into `schemas/`. */
export const SCHEMA_EXPORT_DOCUMENTS = mergeSchemaDocuments(
  JSON_SCHEMA_DOCUMENTS,
  PROTOCOL_1_1_SCHEMA_REGISTRY.documents(),
);
