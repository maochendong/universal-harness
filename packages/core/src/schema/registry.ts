import type { ValidateFunction } from "ajv/dist/2020.js";
import type { TSchema } from "@sinclair/typebox";

import { isProtocolCompatible } from "../version.js";
import { PROTOCOL_1_1_VERSION, PROTOCOL_1_2_VERSION, PROTOCOL_1_3_VERSION } from "../protocol.js";
import { createDomainSchemaRegistry, mergeSchemaDocuments } from "./domain-registry.js";
import { CapabilityPlanRecordSchema, CapabilityPlanRecordV13Schema } from "./capability.js";
import {
  CollaborationConnectionRecordSchema,
  IntegrationRecordSchema,
  LeaseRecordSchema,
  PrincipalSnapshotRecordSchema,
  RemoteApprovalDecisionRecordSchema,
} from "./collaboration.js";
import {
  ProjectContextBundleInvalidationRecordSchema,
  ProjectContextBundleRecordSchema,
} from "./context.js";
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
import {
  FeedbackAnalysisInputSchema,
  FeedbackAnalysisOutputSchema,
  FeedbackAnalysisRecordSchema,
} from "./feedback-analysis.js";
import { NodeSchema } from "./node.js";
import { ObservationEventSchema } from "./observation.js";
import { LedgerOperationSchema, OperationSchema, WorkflowOperationSchema } from "./operation.js";
import { PluginManifestSchema } from "./plugin.js";
import {
  CaptureModelProviderBindingRecordSchema,
  ProfileDecisionRecordSchema,
  ProfileDefinitionV11Schema,
  ProfileRecommendationRecordSchema,
  ProjectProfileRecordSchema,
} from "./profile.js";
import { ImpactAdvisoryOutputSchema, ImpactAdvisoryRecordSchema } from "./impact-advisory.js";
import {
  DesignArtifactContentSchema,
  DesignProposalOutputSchema,
  DesignSetContentSchema,
  DesignSetProposalRecordSchema,
} from "./design-set.js";
import { DesignReviewOutputSchema, DesignReviewRecordSchema } from "./design-review.js";
import {
  TaskTddContractSchema,
  PlanProposalOutputSchema,
  PlanProposalRecordSchema,
} from "./plan.js";
import { TddCycleRecordSchema } from "./tdd.js";
import { ModelInvocationRecordSchema, ModelPortFailureSchema } from "./model-invocation.js";
import { PromptContractSchema, PromptPreparationFailureSchema } from "./prompt.js";
import {
  PrdEntityLineageRecordSchema,
  PrdProposalContentSchema,
  PrdProposalDraftSchema,
  PrdProposalRecordSchema,
  PrdValidationReportRecordSchema,
} from "./proposal.js";
import { RuntimeSchema } from "./runtime.js";
import { TaskLeaseRecordSchema, WaveIntegrationRecordSchema } from "./scheduling.js";
import {
  ApprovalBriefInputSchema,
  ApprovalBriefOutputSchema,
  ContextEnrichmentOutputSchema,
  GroundedSynthesisRecordSchema,
  IterationNarrativeInputSchema,
  IterationNarrativeOutputSchema,
  ProjectDiscoveryInputSchema,
  ProjectDiscoveryOutputSchema,
} from "./synthesis.js";
import { AcceptedPrdRecordSchema, RequirementBaselineRecordSchema } from "./acceptance.js";
import {
  ManualReviewInputRecordSchema,
  PrdReviewReportDraftSchema,
  PrdReviewReportRecordSchema,
} from "./review.js";
import { CaptureRiskAssessmentRecordSchema } from "./risk.js";
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
 * clarification, invocation, checkpoint and blocker records; Task 5
 * contributes the project context bundle/invalidation records, the grounded
 * synthesis record and the versioned purpose-bound input/output schemas.
 * Task 6 contributes the PRD proposal record/content/draft, the entity
 * lineage record and the deterministic validation report. Task 7 contributes
 * the review report/draft, manual review input, risk assessment, accepted PRD
 * and requirement baseline records plus the versioned approval-brief input.
 * PG-0 contributes the prompt contract and prompt preparation failure
 * registry schemas.
 */
export const PROTOCOL_1_1_SCHEMA_REGISTRY = createDomainSchemaRegistry({
  protocolVersion: PROTOCOL_1_1_VERSION,
  entries: [
    { key: "profile-definition", schema: ProfileDefinitionV11Schema },
    { key: "project-profile", schema: ProjectProfileRecordSchema },
    { key: "profile-recommendation", schema: ProfileRecommendationRecordSchema },
    { key: "profile-decision", schema: ProfileDecisionRecordSchema },
    { key: "model-provider-binding", schema: CaptureModelProviderBindingRecordSchema },
    { key: "prompt-contract", schema: PromptContractSchema },
    { key: "prompt-preparation-failure", schema: PromptPreparationFailureSchema },
    { key: "model-invocation", schema: ModelInvocationRecordSchema },
    { key: "model-port-failure", schema: ModelPortFailureSchema },
    { key: "impact-advisory", schema: ImpactAdvisoryRecordSchema },
    { key: "impact-advisory-output", schema: ImpactAdvisoryOutputSchema },
    { key: "design-set-proposal", schema: DesignSetProposalRecordSchema },
    { key: "design-set-content", schema: DesignSetContentSchema },
    { key: "design-artifact-content", schema: DesignArtifactContentSchema },
    { key: "design-proposal-output", schema: DesignProposalOutputSchema },
    { key: "design-review", schema: DesignReviewRecordSchema },
    { key: "design-review-output", schema: DesignReviewOutputSchema },
    { key: "task-tdd-contract", schema: TaskTddContractSchema },
    { key: "plan-proposal", schema: PlanProposalRecordSchema },
    { key: "plan-proposal-output", schema: PlanProposalOutputSchema },
    { key: "tdd-cycle", schema: TddCycleRecordSchema },
    { key: "feedback-analysis", schema: FeedbackAnalysisRecordSchema },
    { key: "feedback-analysis-output", schema: FeedbackAnalysisOutputSchema },
    { key: "feedback-analysis-input", schema: FeedbackAnalysisInputSchema },
    { key: "capability-plan", schema: CapabilityPlanRecordSchema },
    { key: "capture-session", schema: CaptureSessionRecordSchema },
    { key: "clarification-question", schema: ClarificationQuestionRecordSchema },
    { key: "clarification-answer", schema: ClarificationAnswerRecordSchema },
    { key: "capture-invocation", schema: CaptureInvocationRecordSchema },
    { key: "capture-checkpoint", schema: CaptureCheckpointRecordSchema },
    { key: "capture-blocker", schema: CaptureBlockerRecordSchema },
    { key: "project-context-bundle", schema: ProjectContextBundleRecordSchema },
    {
      key: "project-context-bundle-invalidation",
      schema: ProjectContextBundleInvalidationRecordSchema,
    },
    { key: "grounded-synthesis", schema: GroundedSynthesisRecordSchema },
    { key: "project-discovery-input", schema: ProjectDiscoveryInputSchema },
    { key: "project-discovery-output", schema: ProjectDiscoveryOutputSchema },
    { key: "context-enrichment-output", schema: ContextEnrichmentOutputSchema },
    { key: "approval-brief-input", schema: ApprovalBriefInputSchema },
    { key: "approval-brief-output", schema: ApprovalBriefOutputSchema },
    { key: "iteration-narrative-output", schema: IterationNarrativeOutputSchema },
    { key: "iteration-narrative-input", schema: IterationNarrativeInputSchema },
    { key: "prd-proposal", schema: PrdProposalRecordSchema },
    { key: "prd-proposal-content", schema: PrdProposalContentSchema },
    { key: "prd-proposal-draft", schema: PrdProposalDraftSchema },
    { key: "prd-entity-lineage", schema: PrdEntityLineageRecordSchema },
    { key: "prd-validation-report", schema: PrdValidationReportRecordSchema },
    { key: "prd-review-report", schema: PrdReviewReportRecordSchema },
    { key: "prd-review-report-draft", schema: PrdReviewReportDraftSchema },
    { key: "manual-review-input", schema: ManualReviewInputRecordSchema },
    { key: "capture-risk-assessment", schema: CaptureRiskAssessmentRecordSchema },
    { key: "accepted-prd", schema: AcceptedPrdRecordSchema },
    { key: "requirement-baseline", schema: RequirementBaselineRecordSchema },
  ],
});

/**
 * Protocol 1.2 (M3 remote collaboration): the five frozen authoritative
 * record schemas — the project Ledger holds collaboration-connection and
 * integration; the protected Control Ref holds principal-snapshot, lease and
 * remote-approval-decision. No derived state registers a schema here.
 */
export const PROTOCOL_1_2_SCHEMA_REGISTRY = createDomainSchemaRegistry({
  protocolVersion: PROTOCOL_1_2_VERSION,
  entries: [
    { key: "collaboration-connection", schema: CollaborationConnectionRecordSchema },
    { key: "principal-snapshot", schema: PrincipalSnapshotRecordSchema },
    { key: "lease", schema: LeaseRecordSchema },
    { key: "remote-approval-decision", schema: RemoteApprovalDecisionRecordSchema },
    { key: "integration", schema: IntegrationRecordSchema },
  ],
});

/**
 * Protocol 1.3 (M4 local multi-agent scheduling): the only two authoritative
 * record kinds M4 introduces — task-lease and wave-integration. Task state,
 * scheduler state, parallel groups and driver locks stay derived projections
 * and never register a schema here.
 */
export const PROTOCOL_1_3_SCHEMA_REGISTRY = createDomainSchemaRegistry({
  protocolVersion: PROTOCOL_1_3_VERSION,
  entries: [
    { key: "task-lease", schema: TaskLeaseRecordSchema },
    { key: "wave-integration", schema: WaveIntegrationRecordSchema },
  ],
});

/**
 * The Protocol 1.3 CapabilityPlan revision schema (M4 design 10.2). It is not
 * a new domain record kind — it versions the existing `capability_plan` kind —
 * so the version-suffixed document name keeps both generations readable
 * side by side; a registry key cannot carry the dotted suffix.
 */
export const CAPABILITY_PLAN_1_3_SCHEMA_DOCUMENT_NAME = "capability-plan-1.3.schema.json";

const SCHEMA_ID_BASE_1_3 = "https://schemas.universal-harness.dev/1.3";

const CAPABILITY_PLAN_1_3_SCHEMA_DOCUMENTS: Record<string, Record<string, unknown>> = {
  [CAPABILITY_PLAN_1_3_SCHEMA_DOCUMENT_NAME]: JSON.parse(
    JSON.stringify({
      $schema: JSON_SCHEMA_DIALECT,
      $id: `${SCHEMA_ID_BASE_1_3}/capability-plan-1.3.schema.json`,
      ...CapabilityPlanRecordV13Schema,
    }),
  ) as Record<string, unknown>,
};

/** Every document scripts/write-schemas.mjs persists into `schemas/`. */
export const SCHEMA_EXPORT_DOCUMENTS = mergeSchemaDocuments(
  JSON_SCHEMA_DOCUMENTS,
  PROTOCOL_1_1_SCHEMA_REGISTRY.documents(),
  PROTOCOL_1_2_SCHEMA_REGISTRY.documents(),
  PROTOCOL_1_3_SCHEMA_REGISTRY.documents(),
  CAPABILITY_PLAN_1_3_SCHEMA_DOCUMENTS,
);
