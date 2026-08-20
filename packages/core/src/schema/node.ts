import { Type, type Static } from "@sinclair/typebox";

import {
  DigestSchema,
  ExtensionsSchema,
  IdentifierSchema,
  LocatorSchema,
  ProvenanceSchema,
  SourceSchema,
  enumerated,
  persistedRecordProperties,
  strictObject,
} from "./common.js";

export const NODE_TYPES = [
  "Project",
  "Repository",
  "Iteration",
  "Intent",
  "Requirement",
  "Constraint",
  "Decision",
  "Component",
  "ExecutionPlan",
  "Task",
  "CodeArtifact",
  "Policy",
  "ToolDefinition",
  "Test",
  "EvaluationCase",
  "Gate",
  "ContextBundle",
  "Run",
  "Checkpoint",
  "Evidence",
  "ApprovalRequest",
  "Approval",
  "Finding",
  "RootCauseAnalysis",
  "ImprovementCandidate",
  "ImpactSet",
  "DesignSet",
  "DesignArtifact",
] as const;

export const NODE_STATUSES = ["proposed", "accepted", "superseded", "tombstoned"] as const;

export const ITERATION_STATES = [
  "draft",
  "planned",
  "running",
  "verifying",
  "blocked",
  "completed",
  "aborted",
] as const;

export const POLICY_MERGE_OPERATORS = [
  "hard_ceiling",
  "allow_intersection",
  "deny_union",
  "approval_union",
  "strongest_control",
  "project_default",
] as const;

export const PolicyFieldSchema = strictObject({
  path: Type.String({ minLength: 1, pattern: "^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$" }),
  merge_operator: enumerated(POLICY_MERGE_OPERATORS),
  value: Type.Unknown(),
});

export const NodeSchema = Type.Object(
  {
    ...persistedRecordProperties("node"),
    id: IdentifierSchema,
    type: enumerated(NODE_TYPES),
    revision: Type.Integer({ minimum: 1 }),
    status: enumerated(NODE_STATUSES),
    source: SourceSchema,
    provenance: ProvenanceSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    digest: DigestSchema,
    locator: Type.Optional(LocatorSchema),
    iteration_state: Type.Optional(enumerated(ITERATION_STATES)),
    policy_fields: Type.Optional(Type.Array(PolicyFieldSchema, { minItems: 1 })),
    extensions: Type.Optional(ExtensionsSchema),
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: { properties: { type: { const: "Iteration" } }, required: ["type"] },
        then: { properties: { iteration_state: {} }, required: ["iteration_state"] },
        else: {
          not: { properties: { iteration_state: {} }, required: ["iteration_state"] },
        },
      },
      {
        if: { properties: { type: { const: "Policy" } }, required: ["type"] },
        then: { properties: { policy_fields: {} }, required: ["policy_fields"] },
        else: {
          not: { properties: { policy_fields: {} }, required: ["policy_fields"] },
        },
      },
    ],
  },
);

export type NodeRecord = Static<typeof NodeSchema>;
