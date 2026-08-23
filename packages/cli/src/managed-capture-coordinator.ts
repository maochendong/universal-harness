import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  APPROVAL_BRIEF_PROMPT_VERSION,
  GROUNDED_SYNTHESIS_SCHEMA_VERSIONS,
  PRD_PROPOSAL_PROMPT_PORT_ID,
  PRD_PROPOSAL_PROMPT_VERSION,
  PRD_REVIEW_PROMPT_PORT_ID,
  PRD_REVIEW_PROMPT_VERSION,
  PROJECT_DISCOVERY_PROMPT_VERSION,
  allowedSourceKindsForProfile,
  appendProjectContextBundleRecord,
  canonicalizeJson,
  compileCaptureModelProviderBindings,
  contentDigest,
  createCaptureAcceptanceStageHandler,
  createCaptureApprovalBriefStageHandler,
  createCaptureModelProviderBindingRecord,
  createCaptureProposalStageHandlers,
  createCaptureReviewStageHandlers,
  createCaptureRiskStageHandlers,
  createLocalGitProjectContextAdapter,
  manualCaptureProposalProfile,
  manualCaptureReviewProfile,
  createPrdCaptureCoordinator,
  harnessRootFor,
  modelSlotDefaultsForProfile,
  readCaptureModelProviderBindings,
  readCaptureRiskAssessments,
  readPrdProposalRevisions,
  readPrdReviewReports,
  readPrdValidationReports,
  resolveModelBackedProposalProfile,
  resolveModelBackedReviewProfile,
  submitCaptureModelProviderBindings,
  type CaptureApprovalDecisionView,
  type CaptureBudgetLimits,
  type CaptureModelProviderConfig,
  type CaptureProfileResolution,
  type CaptureRiskPolicy,
  type CaptureSessionRecord,
  type CaptureStageHandler,
  type ModelSlotDefault,
  type PrdCaptureCoordinator,
  type PrdReviewRubric,
  type PrdProposalPort,
  type PrdReviewPort,
  type ProfileId,
  type ProjectContextBudget,
  type ProjectContextSource,
  type ProjectProfileRecord,
  type TrustedProviderRegistry,
} from "@universal-harness-internal/core";
import {
  createModelBackedGroundedSynthesisPort,
  createModelBackedPrdProposalPort,
  createModelBackedPrdReviewPort,
  type ManagedInvocationBudget,
  type ResolvedManagedProvider,
} from "@universal-harness-internal/runtime";

import { assembleModelProviders } from "./model-providers.js";
import { profileRequiresManagedModelPorts } from "./managed-pipeline-ports.js";
import { createShippedPromptContractRegistry } from "./prompt-registry.js";
import type { ProjectRuntimeConfig } from "./project-runtime-config.js";

/**
 * Managed capture coordinator assembly (intent-to-prd design 7/11.1, prompt
 * governance addendum 5.2): the production composition point for the
 * protocol-1.1 PrdCaptureCoordinator. The committed `model_providers`
 * declarations resolve the four capture slots (prd_proposal, prd_review and
 * the Capture-scope grounded purposes project_discovery/approval_brief)
 * through the same ManagedProviderResolver the pipeline ports use; the two
 * Capture-scope purposes are compiled into ModelProviderBindings and committed
 * against the ProfileDecision before the coordinator is built, so the
 * invocation barrier always finds its binding digests. Every stage handler is
 * the real domain factory — proposal/validation, review, risk, approval brief
 * and the accepted transaction — over model-backed ports; only the context
 * stage is wired here, wrapping the local-git adapter exactly as the domain
 * test pipelines do. A Lite project without `model_providers` gets no
 * coordinator (undefined); a Standard/Governed project without coverage for
 * any capture slot — including no declaration at all — throws instead of
 * degrading (design 11.2 preflight closure): nothing
 * fails open. API keys never travel through here: only the env var names
 * reach the provider instances.
 */

export type ManagedCaptureCoordinatorErrorCode = "slot_unresolved" | "binding_drift";

export class ManagedCaptureCoordinatorError extends Error {
  readonly code: ManagedCaptureCoordinatorErrorCode;

  constructor(code: ManagedCaptureCoordinatorErrorCode, message: string) {
    super(`managed capture coordinator: ${message}`);
    this.name = "ManagedCaptureCoordinatorError";
    this.code = code;
  }
}

export interface ManagedCaptureCoordinatorDeps {
  readonly projectRoot: string;
  readonly runtimeConfig: ProjectRuntimeConfig;
  /** The latest committed project profile; its id and policy digest bind the assembly. */
  readonly profile: ProjectProfileRecord;
  /**
   * Identity of the ProfileDecision the Capture-scope bindings bind. Core has
   * no profile-decision reader yet, so the caller supplies both fields (the
   * CLI derives them deterministically from the stable decision inputs).
   */
  readonly profile_decision_id: string;
  readonly profile_decision_digest: string;
  /** Baseline the capture reads against; bound into the binding record and every bundle. */
  readonly project_baseline_digest: string;
  /** The capture risk policy the deterministic risk stage routes approvals with. */
  readonly policy: CaptureRiskPolicy;
  /** The review rubric the review stage canonicalizes reports against. */
  readonly rubric: PrdReviewRubric;
  /** Returns the current ledger baseline commit the accepted transaction builds on. */
  readonly readBaseline: () => string;
  readonly readApprovalDecision?: (
    requestId: string,
    decisionId: string,
  ) => CaptureApprovalDecisionView | undefined;
  readonly resolveProfileDecision?: (
    session: CaptureSessionRecord,
  ) => CaptureProfileResolution | undefined;
  readonly budget?: CaptureBudgetLimits;
  readonly fetch?: typeof fetch;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly providerRegistry?: TrustedProviderRegistry;
}

export interface ManagedCaptureCoordinator {
  readonly coordinator: PrdCaptureCoordinator;
  /** Digest of the Capture-scope binding record this assembly committed or reused. */
  readonly binding_record_digest?: string;
  /** False when the identical binding record was already committed (idempotent reuse). */
  readonly binding_committed: boolean;
}

/** Context-bundle budget; mirrors the managed interpreter's proposal budget. */
const CAPTURE_CONTEXT_BUDGET: ProjectContextBudget = {
  max_files: 16,
  max_bytes_per_source: 4096,
  max_total_bytes: 65536,
  max_summary_chars: 400,
} as const;

const PRODUCER_IDENTITY = "universal-harness-cli" as const;

function deterministicLiteProposalPort(): PrdProposalPort {
  return {
    name: "deterministic-lite-pack",
    propose(input) {
      const intent = input.session.intent_text;
      const source = [
        {
          source_kind: "intent" as const,
          source_id: "intent",
          source_digest: input.session.intent_digest,
        },
      ];
      return {
        status: "proposed",
        draft: {
          schema_version: "1.1.0",
          intent: { text: intent, digest: input.session.intent_digest },
          problem_statement: intent,
          goals: [
            {
              draft_key: "goal-primary",
              lineage: { kind: "new" },
              proposed_source_bindings: source,
              statement: intent,
            },
          ],
          non_goals: [],
          actors: [
            {
              draft_key: "actor-operator",
              lineage: { kind: "new" },
              proposed_source_bindings: source,
              name: "项目操作者",
              description: "提交需求并验证可观察结果。",
            },
          ],
          scenarios: [
            {
              draft_key: "scenario-primary",
              lineage: { kind: "new" },
              proposed_source_bindings: source,
              actor_id: "actor-operator",
              precondition: "项目已被 Harness 接管。",
              action: intent,
              observable_outcome: intent,
              scenario_kind: "primary",
            },
            {
              draft_key: "scenario-failure",
              lineage: { kind: "new" },
              proposed_source_bindings: source,
              actor_id: "actor-operator",
              precondition: "必要门禁未通过。",
              action: "Harness 尝试完成本次迭代。",
              observable_outcome: "迭代保持阻塞且不会生成完成快照。",
              scenario_kind: "failure",
            },
          ],
          requirements: [
            {
              draft_key: "requirement-primary",
              lineage: { kind: "new" },
              proposed_source_bindings: source,
              statement: intent,
              priority: "must",
              change_kind: "must_change",
              scenario_ids: ["scenario-primary", "scenario-failure"],
              acceptance_criterion_ids: ["criterion-primary", "criterion-failure"],
            },
          ],
          constraints: [],
          acceptance_criteria: [
            {
              draft_key: "criterion-primary",
              lineage: { kind: "new" },
              proposed_source_bindings: source,
              requirement_id: "requirement-primary",
              precondition: "项目已被 Harness 接管。",
              action: intent,
              observable_outcome: intent,
              verification_intent: "运行与该需求绑定的必要机械门禁。",
              test_first_example: "先让绑定的验收测试失败，再实现使其通过。",
              scenario_kind: "primary",
            },
            {
              draft_key: "criterion-failure",
              lineage: { kind: "new" },
              proposed_source_bindings: source,
              requirement_id: "requirement-primary",
              precondition: "必要门禁报告失败。",
              action: "Harness 评估本次迭代。",
              observable_outcome: "迭代保持阻塞且不会生成完成快照。",
              verification_intent: "运行失败门禁并检查终态。",
              test_first_example: "失败门禁必须阻止完成快照。",
              scenario_kind: "failure",
            },
          ],
          assumptions: [],
          dependencies: [],
          risks: [],
          open_questions: [],
          glossary: [],
          context_source_refs: [],
        },
      };
    },
  };
}

function deterministicLiteReviewPort(): PrdReviewPort {
  return {
    name: "deterministic-lite-review",
    review(input) {
      if (!input.validation_report.passed) {
        return {
          status: "failed",
          failure: {
            code: "invalid_output",
            retryable: false,
            summary: "Lite deterministic review requires passed hard gates",
          },
        };
      }
      return {
        status: "completed",
        report: {
          verdict: "accept",
          dimensions: input.rubric.dimensions.map((dimension) => ({
            dimension_id: dimension.dimension_id,
            status: "satisfied" as const,
            notes: "确定性硬门禁已验证该维度所需的结构、覆盖与可测试性。",
          })),
          findings: [],
          suggested_questions: [],
        },
      };
    },
  };
}

/**
 * Production defaults for the capture review rubric and risk policy (slice 2;
 * a project-level override can be wired later). The rubric mirrors the domain
 * test fixtures — clarity/completeness/testability, all mandatory. Lite and
 * Standard permit the domain engine's narrow low/non-material/high-confidence
 * policy route; Governed always retains human approval. Risk, upgrade and deny
 * rules remain authoritative and cannot be bypassed by this default.
 */
export const DEFAULT_CAPTURE_REVIEW_RUBRIC: PrdReviewRubric = {
  rubric_id: "capture-review-rubric",
  dimensions: [
    { dimension_id: "clarity", prompt: "Is every requirement unambiguous?" },
    { dimension_id: "completeness", prompt: "Does the PRD cover the intent?" },
    { dimension_id: "testability", prompt: "Is every criterion observable?" },
  ],
  mandatory_dimension_ids: ["clarity", "completeness", "testability"],
};

export function defaultCaptureRiskPolicy(
  projectId: string,
  profileId: ProfileId,
): CaptureRiskPolicy {
  return {
    project_id: projectId,
    profile_id: profileId,
    allow_policy_auto_approval: profileId !== "governed",
    policy_actor: `policy:capture-${profileId}@1`,
  };
}

/** The Capture-scope grounded purposes, in canonical (sorted) order. */
const CAPTURE_SCOPE_PURPOSES = ["approval_brief", "project_discovery"] as const;

const PROMPT_VERSION_BY_PURPOSE = {
  approval_brief: APPROVAL_BRIEF_PROMPT_VERSION,
  project_discovery: PROJECT_DISCOVERY_PROMPT_VERSION,
} as const;

const CAPTURE_LOCATOR_PREFIX = "capture://" as const;

function failClosed(message: string): never {
  throw new Error(`managed capture coordinator: ${message}`);
}

/**
 * Resolve one bundled capture record back to its canonical content. The
 * approval bundle cites the committed approval object through `capture://`
 * locators (`capture://prd-proposal/<content_digest>` and the report/assessment
 * digests of the validation, review and risk records); each resolves through
 * the typed stores — schema- and envelope-verified — and must match both the
 * locator digest and the source digest the bundle pinned. An unresolvable
 * source fails closed: a prompt must never be compiled over invented content.
 */
function captureRecordContent(projectRoot: string, source: ProjectContextSource): string {
  const tail = source.locator.slice(CAPTURE_LOCATOR_PREFIX.length);
  const slash = tail.indexOf("/");
  const kind = tail.slice(0, slash);
  const digest = tail.slice(slash + 1);
  const sessions = captureSessionIds(projectRoot, kind);
  const candidates = sessions.flatMap((sessionId) =>
    captureRecordDigests(projectRoot, kind, sessionId),
  );
  const match = candidates.find(
    (candidate) =>
      candidate.bound_digest === digest && candidate.record_digest === source.source_digest,
  );
  if (match === undefined) {
    failClosed(`bundle source ${source.locator} does not resolve to a committed capture record`);
  }
  return match.content;
}

/** Session directories of one capture record kind, sorted for determinism. */
function captureSessionIds(projectRoot: string, kind: string): string[] {
  const storeDirectory = {
    "prd-proposal": "proposals",
    "prd-validation": "validations",
    "prd-review": "reviews",
    "capture-risk": "risk",
  }[kind];
  if (storeDirectory === undefined) return [];
  const directory = join(harnessRootFor(projectRoot), "artifacts", "capture", storeDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Digest view of every committed record of one capture kind in one session. */
function captureRecordDigests(
  projectRoot: string,
  kind: string,
  sessionId: string,
): readonly {
  readonly record_digest: string;
  readonly bound_digest: string;
  readonly content: string;
}[] {
  switch (kind) {
    case "prd-proposal":
      return readPrdProposalRevisions(projectRoot, sessionId).map((record) => ({
        record_digest: record.record_digest,
        bound_digest: record.content_digest,
        content: canonicalizeJson(record),
      }));
    case "prd-validation":
      return readPrdValidationReports(projectRoot, sessionId).map((record) => ({
        record_digest: record.record_digest,
        bound_digest: record.report_digest,
        content: canonicalizeJson(record),
      }));
    case "prd-review":
      return readPrdReviewReports(projectRoot, sessionId).map((record) => ({
        record_digest: record.record_digest,
        bound_digest: record.report_digest,
        content: canonicalizeJson(record),
      }));
    case "capture-risk":
      return readCaptureRiskAssessments(projectRoot, sessionId).map((record) => ({
        record_digest: record.record_digest,
        bound_digest: record.assessment_digest,
        content: canonicalizeJson(record),
      }));
    default:
      return [];
  }
}

/**
 * The canonical content of one bundled source: `capture://` locators resolve
 * to the committed capture records; anything else is a plain project locator
 * the local-git adapter vetted, read from the work tree.
 */
function bundleContent(projectRoot: string, source: ProjectContextSource): string {
  if (source.locator.startsWith(CAPTURE_LOCATOR_PREFIX)) {
    return captureRecordContent(projectRoot, source);
  }
  return readFileSync(join(projectRoot, source.locator), "utf8");
}

/** The resolved provider's declared budget, when the assembly supplied one. */
function budgetOf(resolved: ResolvedManagedProvider): { budget?: ManagedInvocationBudget } {
  return resolved.budget === undefined ? {} : { budget: resolved.budget };
}

function stageFailure(
  code: string,
  summary: string,
  retryable: boolean,
): { kind: "stage_failed"; failure: { code: string; summary: string; retryable: boolean } } {
  return { kind: "stage_failed", failure: { code, summary, retryable } };
}

/** The 11.2 matrix always carries both Capture-scope purposes; absence is a build bug. */
function captureSlotDefault(
  defaults: readonly ModelSlotDefault[],
  purpose: (typeof CAPTURE_SCOPE_PURPOSES)[number],
): ModelSlotDefault {
  const found = defaults.find(
    (candidate) => candidate.slot_id === "grounded_synthesis" && candidate.purpose === purpose,
  );
  if (found === undefined) {
    throw new ManagedCaptureCoordinatorError(
      "slot_unresolved",
      `the profile slot matrix carries no grounded_synthesis/${purpose} default`,
    );
  }
  return found;
}

/**
 * The context stage (design 7.2/8.3): the only handler without a domain
 * stage factory, wired here exactly as the core test pipelines do — the
 * invocation purpose selects the bundle purpose, the local-git adapter
 * compiles under the profile's source-kind matrix, and the accepted bundle is
 * persisted before its digest is returned. A blocked bundle is a stage
 * failure, never a silent empty context.
 */
function createManagedCompileContextHandler(deps: {
  readonly projectRoot: string;
  readonly profile: ProjectProfileRecord;
}): CaptureStageHandler {
  const contextAdapter = createLocalGitProjectContextAdapter({ projectRoot: deps.projectRoot });
  return async (request) => {
    const invocation = request.invocation;
    if (invocation === undefined) {
      return stageFailure(
        "invocation_missing",
        "the context stage requires a committed invocation record",
        false,
      );
    }
    const purpose =
      invocation.purpose === "context_proposal"
        ? "proposal"
        : invocation.purpose === "context_review"
          ? "review"
          : undefined;
    if (purpose === undefined) {
      return stageFailure(
        "invocation_missing",
        `the context stage cannot serve invocation purpose ${invocation.purpose}`,
        false,
      );
    }
    const session = request.session;
    const compiled = await contextAdapter.compile({
      session_id: session.session_id,
      purpose,
      intent_text: session.intent_text,
      project_root_kind: "managed",
      project_baseline_digest: session.project_baseline_digest,
      project_profile_digest: session.project_profile_digest,
      capture_policy_digest: session.capture_policy_digest,
      allowed_source_kinds: allowedSourceKindsForProfile(deps.profile.profile_id),
      path_policy: {},
      budget: CAPTURE_CONTEXT_BUDGET,
    });
    if (compiled.status !== "compiled") {
      return stageFailure(
        compiled.failure.code,
        compiled.failure.summary,
        compiled.failure.retryable,
      );
    }
    appendProjectContextBundleRecord(deps.projectRoot, compiled.bundle);
    return { kind: "context_compiled", bundle_digest: compiled.bundle.content_digest };
  };
}

/**
 * Compile and commit the Capture-scope bindings (design 11.1): one binding
 * per grounded purpose, provider identity/config from the resolved slot,
 * required/failure_mode from the profile slot matrix, contract fields derived
 * from the shipped registry. Recommitting the identical record is an
 * idempotent reuse; a different record already committed for the same
 * ProfileDecision is drift and fails closed.
 */
function commitCaptureScopeBindings(
  deps: ManagedCaptureCoordinatorDeps,
  registry: ReturnType<typeof createShippedPromptContractRegistry>,
  resolvedByPurpose: Readonly<
    Record<(typeof CAPTURE_SCOPE_PURPOSES)[number], ResolvedManagedProvider>
  >,
): { readonly binding_record_digest: string; readonly binding_committed: boolean } {
  const slotDefaults = modelSlotDefaultsForProfile(deps.profile.profile_id);
  const configs: CaptureModelProviderConfig[] = CAPTURE_SCOPE_PURPOSES.map((purpose) => {
    const resolved = resolvedByPurpose[purpose];
    const slotDefault = captureSlotDefault(slotDefaults, purpose);
    return {
      slot_id: "grounded_synthesis",
      purpose,
      required: slotDefault.required,
      provider_identity: resolved.provider_config.provider_identity,
      config_digest: resolved.provider_config.config_digest,
      prompt_version: PROMPT_VERSION_BY_PURPOSE[purpose],
      schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS[purpose],
      budget_profile: resolved.provider_config.budget_profile,
      failure_mode: slotDefault.failure_mode,
    };
  });
  const bindings = compileCaptureModelProviderBindings({
    prompt_contract_resolver: registry,
    configs,
  });
  const record = createCaptureModelProviderBindingRecord({
    project_id: deps.profile.project_id,
    profile_decision_id: deps.profile_decision_id,
    profile_decision_digest: deps.profile_decision_digest,
    policy_digest: deps.profile.policy_digest,
    config_digest: contentDigest({
      profile_decision_digest: deps.profile_decision_digest,
      bindings,
    }),
    baseline_digest: deps.project_baseline_digest,
    bindings,
  });
  const existing = readCaptureModelProviderBindings(deps.projectRoot).filter(
    (candidate) => candidate.profile_decision_digest === deps.profile_decision_digest,
  );
  if (existing.length > 0) {
    if (!existing.some((candidate) => candidate.record_digest === record.record_digest)) {
      throw new ManagedCaptureCoordinatorError(
        "binding_drift",
        "a different Capture-scope binding record is already committed for this profile decision",
      );
    }
    return { binding_record_digest: record.record_digest, binding_committed: false };
  }
  submitCaptureModelProviderBindings(deps.projectRoot, record);
  return { binding_record_digest: record.record_digest, binding_committed: true };
}

function createDeterministicLiteCaptureCoordinator(
  deps: ManagedCaptureCoordinatorDeps,
): ManagedCaptureCoordinator {
  const proposalVersion = "deterministic-lite-pack.v1";
  const reviewVersion = "deterministic-lite-review.v1";
  const proposalStages = createCaptureProposalStageHandlers({
    projectRoot: deps.projectRoot,
    proposal: deterministicLiteProposalPort(),
    adapter_profile: manualCaptureProposalProfile({
      adapter_profile_digest: contentDigest({
        adapter: "deterministic-lite-pack",
        version: proposalVersion,
      }),
      prompt_version_digest: contentDigest(proposalVersion),
      producer_identity: PRODUCER_IDENTITY,
    }),
  });
  const reviewStages = createCaptureReviewStageHandlers({
    projectRoot: deps.projectRoot,
    review: deterministicLiteReviewPort(),
    rubric: deps.rubric,
    adapter_profile: manualCaptureReviewProfile({
      adapter_profile_digest: contentDigest({
        adapter: "deterministic-lite-review",
        version: reviewVersion,
      }),
      prompt_version_digest: contentDigest(reviewVersion),
      reviewer_identity: `${PRODUCER_IDENTITY}:lite-review`,
    }),
  });
  const riskStages = createCaptureRiskStageHandlers({
    projectRoot: deps.projectRoot,
    policy: deps.policy,
    policy_digest: deps.profile.policy_digest,
  });
  const accept = createCaptureAcceptanceStageHandler({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    policy_digest: deps.profile.policy_digest,
  });
  return {
    coordinator: createPrdCaptureCoordinator({
      projectRoot: deps.projectRoot,
      handlers: {
        compileContext: createManagedCompileContextHandler({
          projectRoot: deps.projectRoot,
          profile: deps.profile,
        }),
        propose: proposalStages.propose,
        validate: proposalStages.validate,
        review: reviewStages.review,
        assessRisk: riskStages.assessRisk,
        accept,
      },
      requireCaptureBindings: false,
      ...(deps.readApprovalDecision === undefined
        ? {}
        : { readApprovalDecision: deps.readApprovalDecision }),
      ...(deps.resolveProfileDecision === undefined
        ? {}
        : { resolveProfileDecision: deps.resolveProfileDecision }),
      ...(deps.budget === undefined ? {} : { budget: deps.budget }),
    }),
    binding_committed: false,
  };
}

export function createManagedCaptureCoordinator(
  deps: ManagedCaptureCoordinatorDeps,
): ManagedCaptureCoordinator | undefined {
  // Provider closure is re-verified deterministically at preflight (design
  // 11.2): a Standard/Governed project with no `model_providers` at all falls
  // through to the empty resolver so the coverage check below fails closed,
  // exactly like a partial declaration. Lite keeps the legacy fallback.
  if (
    (deps.runtimeConfig.model_providers ?? []).length === 0 &&
    !profileRequiresManagedModelPorts(deps.profile.profile_id)
  ) {
    return createDeterministicLiteCaptureCoordinator(deps);
  }
  const resolver = assembleModelProviders(deps.runtimeConfig, {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.environment === undefined ? {} : { environment: deps.environment }),
    ...(deps.providerRegistry === undefined ? {} : { registry: deps.providerRegistry }),
  });
  const registry = createShippedPromptContractRegistry();

  const slots = [
    PRD_PROPOSAL_PROMPT_PORT_ID,
    PRD_REVIEW_PROMPT_PORT_ID,
    "project_discovery",
    "approval_brief",
  ] as const;
  const resolvedBySlot = new Map<string, ResolvedManagedProvider>();
  for (const slot of slots) {
    const provider = resolver.resolve(slot);
    if (provider !== undefined) resolvedBySlot.set(slot, provider);
  }
  const missing = slots.filter((slot) => !resolvedBySlot.has(slot));
  if (missing.length > 0) {
    throw new ManagedCaptureCoordinatorError(
      "slot_unresolved",
      `no model provider covers capture slot(s): ${missing.join(", ")}`,
    );
  }
  // Post-check lookup: the missing-slot throw above makes this total.
  const covered = (slot: (typeof slots)[number]): ResolvedManagedProvider => {
    const provider = resolvedBySlot.get(slot);
    if (provider === undefined) {
      throw new ManagedCaptureCoordinatorError(
        "slot_unresolved",
        `no model provider covers capture slot ${slot}`,
      );
    }
    return provider;
  };

  const binding = commitCaptureScopeBindings(deps, registry, {
    approval_brief: covered("approval_brief"),
    project_discovery: covered("project_discovery"),
  });

  const shared = {
    projectRoot: deps.projectRoot,
    registry,
    profile_id: deps.profile.profile_id,
    bundle_content: (source: ProjectContextSource) => bundleContent(deps.projectRoot, source),
  } as const;

  const proposalProfile = resolveModelBackedProposalProfile({
    resolver: registry,
    // No adapter-profile/prompt-version records exist on this path yet; both
    // digests derive deterministically from the stable inputs.
    adapter_profile_digest: contentDigest({
      producer_identity: PRODUCER_IDENTITY,
      prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
      profile_id: deps.profile.profile_id,
    }),
    prompt_version_digest: contentDigest(PRD_PROPOSAL_PROMPT_VERSION),
    producer_identity: PRODUCER_IDENTITY,
    prompt_version: PRD_PROPOSAL_PROMPT_VERSION,
  });
  const reviewProfile = resolveModelBackedReviewProfile({
    resolver: registry,
    adapter_profile_digest: contentDigest({
      producer_identity: PRODUCER_IDENTITY,
      prompt_version: PRD_REVIEW_PROMPT_VERSION,
      profile_id: deps.profile.profile_id,
    }),
    prompt_version_digest: contentDigest(PRD_REVIEW_PROMPT_VERSION),
    reviewer_identity: PRODUCER_IDENTITY,
    prompt_version: PRD_REVIEW_PROMPT_VERSION,
  });

  const proposalStages = createCaptureProposalStageHandlers({
    projectRoot: deps.projectRoot,
    proposal: createModelBackedPrdProposalPort({
      ...shared,
      provider_config: covered(PRD_PROPOSAL_PROMPT_PORT_ID).provider_config,
      provider: covered(PRD_PROPOSAL_PROMPT_PORT_ID).provider,
      ...budgetOf(covered(PRD_PROPOSAL_PROMPT_PORT_ID)),
    }),
    adapter_profile: proposalProfile,
  });
  const reviewStages = createCaptureReviewStageHandlers({
    projectRoot: deps.projectRoot,
    review: createModelBackedPrdReviewPort({
      ...shared,
      provider_config: covered(PRD_REVIEW_PROMPT_PORT_ID).provider_config,
      provider: covered(PRD_REVIEW_PROMPT_PORT_ID).provider,
      ...budgetOf(covered(PRD_REVIEW_PROMPT_PORT_ID)),
    }),
    rubric: deps.rubric,
    adapter_profile: reviewProfile,
  });
  const riskStages = createCaptureRiskStageHandlers({
    projectRoot: deps.projectRoot,
    policy: deps.policy,
    policy_digest: deps.profile.policy_digest,
  });
  const approvalBrief = createCaptureApprovalBriefStageHandler({
    projectRoot: deps.projectRoot,
    port: createModelBackedGroundedSynthesisPort({
      ...shared,
      provider_config: covered("approval_brief").provider_config,
      provider: covered("approval_brief").provider,
      ...budgetOf(covered("approval_brief")),
    }),
  });
  const accept = createCaptureAcceptanceStageHandler({
    projectRoot: deps.projectRoot,
    readBaseline: deps.readBaseline,
    policy_digest: deps.profile.policy_digest,
  });

  return {
    coordinator: createPrdCaptureCoordinator({
      projectRoot: deps.projectRoot,
      handlers: {
        compileContext: createManagedCompileContextHandler({
          projectRoot: deps.projectRoot,
          profile: deps.profile,
        }),
        propose: proposalStages.propose,
        validate: proposalStages.validate,
        review: reviewStages.review,
        assessRisk: riskStages.assessRisk,
        approvalBrief,
        accept,
      },
      // The assembly always commits its bindings first, so running unbound is
      // a store bug the coordinator must refuse, never a configuration to skip.
      requireCaptureBindings: true,
      ...(deps.readApprovalDecision === undefined
        ? {}
        : { readApprovalDecision: deps.readApprovalDecision }),
      ...(deps.resolveProfileDecision === undefined
        ? {}
        : { resolveProfileDecision: deps.resolveProfileDecision }),
      ...(deps.budget === undefined ? {} : { budget: deps.budget }),
    }),
    binding_record_digest: binding.binding_record_digest,
    binding_committed: binding.binding_committed,
  };
}
