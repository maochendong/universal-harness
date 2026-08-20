import { Type, type Static } from "@sinclair/typebox";

import {
  DigestSchema,
  IdentifierSchema,
  TimestampSchema,
  enumerated,
  strictObject,
} from "./common.js";
import {
  DesignGeneratorProvenanceSchema,
  DesignProposalQuestionSchema,
  TddPathPolicySchema,
} from "./design-set.js";
import { recordEnvelopeSchema } from "./envelope.js";

/**
 * Plan-side TDD schemas (provable TDD design 7.2, plan T13). The
 * TaskTddContract binds every upstream authority digest — accepted PRD,
 * requirement baseline, impact set, design set, capability plan, plan and
 * test strategy — plus the assertion clusters a required task must run. The
 * mode conditionals are schema-enforced: `required` carries exactly one
 * cluster, `not_applicable` a controlled category with a non-empty reason,
 * `framework_bootstrap` its bootstrap profile; the modes never mix.
 */
export const TDD_CONTRACT_MODES = ["required", "not_applicable", "framework_bootstrap"] as const;
export type TddContractMode = (typeof TDD_CONTRACT_MODES)[number];

export const TDD_NOT_APPLICABLE_CATEGORIES = [
  "documentation_only",
  "research_only",
  "non_executable_projection",
] as const;

export const TDD_FAILURE_KINDS = [
  "assertion_failure",
  "contract_mismatch",
  "expected_exception_not_thrown",
  "missing_symbol",
] as const;

/** The auditable failure oracle: restricted matching, never free regexes. */
export const FailureOracleSchema = strictObject({
  selector_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  allowed_failure_kinds: Type.Array(enumerated(TDD_FAILURE_KINDS), { minItems: 1 }),
  assertion_ids: Type.Array(IdentifierSchema, { minItems: 1 }),
  expected_error_codes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  expected_symbols: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  normalized_message_patterns: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
export type FailureOracle = Static<typeof FailureOracleSchema>;

export const AssertionClusterSchema = strictObject({
  cluster_id: IdentifierSchema,
  logical_cycle_id: IdentifierSchema,
  requirement_ids: Type.Array(IdentifierSchema, { minItems: 1 }),
  acceptance_criterion_ids: Type.Array(IdentifierSchema, { minItems: 1 }),
  assertion_ids: Type.Array(IdentifierSchema, { minItems: 1 }),
  test_node_ids: Type.Array(IdentifierSchema, { minItems: 1 }),
  target_gate_id: IdentifierSchema,
  target_test_selectors: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  baseline_guard_gate_ids: Type.Array(IdentifierSchema),
  failure_oracle: FailureOracleSchema,
  path_policy: TddPathPolicySchema,
  framework_profile_digest: DigestSchema,
  refactor_policy: enumerated(["planned", "not_planned"] as const),
});
export type AssertionCluster = Static<typeof AssertionClusterSchema>;

export const TddPhaseBudgetSchema = strictObject({
  max_runs: Type.Integer({ minimum: 1 }),
  max_duration_ms: Type.Integer({ minimum: 1 }),
  max_steps: Type.Optional(Type.Integer({ minimum: 1 })),
  max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type TddPhaseBudget = Static<typeof TddPhaseBudgetSchema>;

export const TddPhaseBudgetsSchema = strictObject({
  test_authoring: TddPhaseBudgetSchema,
  implementation: TddPhaseBudgetSchema,
  refactor: Type.Optional(TddPhaseBudgetSchema),
});
export type TddPhaseBudgets = Static<typeof TddPhaseBudgetsSchema>;

export const FrameworkBootstrapProfileSchema = strictObject({
  framework_profile_id: IdentifierSchema,
  discovery_gate_id: IdentifierSchema,
  pass_fixture_id: IdentifierSchema,
  fail_fixture_id: IdentifierSchema,
  expected_failure_kind: enumerated(TDD_FAILURE_KINDS),
  test_write_paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  test_config_write_paths: Type.Array(Type.String({ minLength: 1 })),
});
export type FrameworkBootstrapProfile = Static<typeof FrameworkBootstrapProfileSchema>;

const contractProperties = {
  contract_id: IdentifierSchema,
  task_id: IdentifierSchema,
  contract_mode: enumerated(TDD_CONTRACT_MODES),
  accepted_prd_digest: DigestSchema,
  requirement_baseline_digest: DigestSchema,
  impact_set_digest: DigestSchema,
  design_set_digest: DigestSchema,
  capability_plan_digest: DigestSchema,
  test_strategy_asset_id: IdentifierSchema,
  test_strategy_digest: DigestSchema,
  plan_digest: DigestSchema,
  assertion_clusters: Type.Array(AssertionClusterSchema),
  not_applicable_binding: Type.Optional(
    strictObject({
      category: enumerated(TDD_NOT_APPLICABLE_CATEGORIES),
      reason: Type.String({ minLength: 1 }),
    }),
  ),
  framework_bootstrap_profile: Type.Optional(FrameworkBootstrapProfileSchema),
  phase_budgets: TddPhaseBudgetsSchema,
  contract_digest: DigestSchema,
} as const;

export const TaskTddContractSchema = Type.Object(contractProperties, {
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { contract_mode: { const: "required" } }, required: ["contract_mode"] },
      then: {
        properties: {
          assertion_clusters: { type: "array", minItems: 1, maxItems: 1 },
          not_applicable_binding: false,
          framework_bootstrap_profile: false,
        },
      },
    },
    {
      if: {
        properties: { contract_mode: { const: "not_applicable" } },
        required: ["contract_mode"],
      },
      then: {
        properties: {
          assertion_clusters: { type: "array", maxItems: 0 },
          framework_bootstrap_profile: false,
        },
        required: ["not_applicable_binding"],
      },
    },
    {
      if: {
        properties: { contract_mode: { const: "framework_bootstrap" } },
        required: ["contract_mode"],
      },
      then: {
        properties: {
          assertion_clusters: { type: "array", maxItems: 0 },
          not_applicable_binding: false,
        },
        required: ["framework_bootstrap_profile"],
      },
    },
  ],
});
export type TaskTddContract = Static<typeof TaskTddContractSchema>;

export const PLAN_PROPOSAL_SCHEMA_VERSION = "plan_proposal.v1" as const;

/**
 * A plan proposal task candidate (model advisory design 8): the model
 * allocates Harness-compiled canonical assertions and proposes the
 * decomposition rationale; it never mints assertion ids, task ids, paths,
 * gates or TDD contracts — the Plan Compiler owns those.
 */
export const PlanProposalTaskCandidateSchema = strictObject({
  task_key: Type.String({ minLength: 1, maxLength: 120 }),
  goal: Type.String({ minLength: 1 }),
  atomicity_rationale: Type.String({ minLength: 1 }),
  assertion_ids: Type.Array(IdentifierSchema),
  requirement_ids: Type.Array(IdentifierSchema),
  decision_ids: Type.Array(IdentifierSchema),
  design_artifact_ids: Type.Array(IdentifierSchema),
  depends_on: Type.Array(Type.String({ minLength: 1, maxLength: 120 })),
  parallelism_rationale: Type.Optional(Type.String({ minLength: 1 })),
  suggested_gate_ids: Type.Array(IdentifierSchema),
  suggested_write_paths: Type.Array(Type.String({ minLength: 1 })),
  suggested_context_budget: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type PlanProposalTaskCandidate = Static<typeof PlanProposalTaskCandidateSchema>;

export const PlanProposalOutputSchema = strictObject({
  purpose: Type.Literal("plan_proposal"),
  schema_version: Type.Literal(PLAN_PROPOSAL_SCHEMA_VERSION),
  tasks: Type.Array(PlanProposalTaskCandidateSchema),
  questions: Type.Array(DesignProposalQuestionSchema),
});
export type PlanProposalOutput = Static<typeof PlanProposalOutputSchema>;

/** The audited plan proposal record: binds the exact compiled input digest. */
export const PlanProposalRecordSchema = recordEnvelopeSchema("plan_proposal", {
  proposal_id: IdentifierSchema,
  workflow_operation_id: IdentifierSchema,
  iteration_id: IdentifierSchema,
  created_at: TimestampSchema,
  generator: DesignGeneratorProvenanceSchema,
  input_digest: DigestSchema,
  output: PlanProposalOutputSchema,
});
export type PlanProposalRecord = Static<typeof PlanProposalRecordSchema>;
