import { contentDigest } from "../identity/digest.js";
import { readCaptureModelProviderBindings } from "../profile/store.js";
import { isProjectContextBundleInvalidated } from "../context/store.js";
import type { ProjectContextBundleRecord } from "../schema/context.js";
import type { CaptureModelProviderBindingRecord, ModelProviderBinding } from "../schema/profile.js";
import {
  GROUNDED_SYNTHESIS_SCHEMA_VERSIONS,
  type ProjectDiscoveryInput,
  type ProjectDiscoveryOutput,
} from "../schema/synthesis.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import { validateGroundedCitations } from "./citations.js";
import type {
  GroundedSynthesisFailure,
  GroundedSynthesisFailureCode,
  GroundedSynthesisPort,
} from "./port.js";
import {
  createGroundedSynthesisRecord,
  deriveGroundedConversationId,
  deriveGroundedRunId,
  SynthesisRecordError,
} from "./records.js";
import {
  discoveryRecommendationFromRecord,
  type ProjectDiscoveryRecommendation,
} from "./recommendation.js";
import { appendGroundedSynthesisRecord, readGroundedSynthesisRecords } from "./store.js";
import type { GroundedSynthesisRecord } from "../schema/synthesis.js";

/**
 * The project_discovery pipeline (unified plan T5, model advisory design
 * 10/11.1). It consumes only the Capture-scope bindings committed by Task 2 —
 * never CapabilityPlan bindings or ad-hoc configuration — compiles the
 * versioned input, runs the port, validates schema and citations against the
 * current bundle, and persists a sealed record before anything downstream
 * may consume the recommendation. The managed provider call itself is wired
 * by T8; here the port is an adapter seam only.
 */
export interface RunProjectDiscoveryDeps {
  readonly projectRoot: string;
  readonly port: GroundedSynthesisPort;
  readonly bundle: ProjectContextBundleRecord;
  /** The ProfileDecision digest whose Capture-scope bindings authorize this call. */
  readonly profileDecisionDigest: string;
  /** The baseline the caller believes is current; drift blocks the call. */
  readonly expectedProjectBaselineDigest: string;
  readonly sessionId?: string;
  readonly operatorIntent?: string;
}

export type ProjectDiscoveryOutcome =
  | {
      readonly status: "completed";
      readonly record: GroundedSynthesisRecord;
      readonly recommendation: ProjectDiscoveryRecommendation;
    }
  | { readonly status: "blocked"; readonly failure: GroundedSynthesisFailure };

function blocked(
  code: GroundedSynthesisFailureCode,
  summary: string,
  retryable = false,
): ProjectDiscoveryOutcome {
  return { status: "blocked", failure: { code, summary, retryable } };
}

interface ResolvedBinding {
  readonly record: CaptureModelProviderBindingRecord;
  readonly binding: ModelProviderBinding;
}

function resolveDiscoveryBinding(
  projectRoot: string,
  profileDecisionDigest: string,
  bundle: ProjectContextBundleRecord,
): ResolvedBinding | ProjectDiscoveryOutcome {
  const records = readCaptureModelProviderBindings(projectRoot).filter(
    (record) => record.profile_decision_digest === profileDecisionDigest,
  );
  const matches: ResolvedBinding[] = records.flatMap((record) =>
    record.bindings
      .filter(
        (binding) =>
          binding.slot_id === "grounded_synthesis" && binding.purpose === "project_discovery",
      )
      .map((binding) => ({ record, binding })),
  );
  if (matches.length === 0) {
    return blocked(
      "provider_required",
      "no committed Capture-scope binding covers grounded_synthesis/project_discovery",
    );
  }
  const distinctRecords = new Set(matches.map((match) => match.record.record_digest));
  if (distinctRecords.size > 1) {
    return blocked(
      "binding_drift",
      "conflicting Capture-scope binding records for project_discovery",
    );
  }
  const resolved = matches[0]!;
  if (
    resolved.record.baseline_digest !== bundle.project_baseline_digest ||
    resolved.record.policy_digest !== bundle.policy_digest
  ) {
    return blocked(
      "binding_drift",
      "the committed Capture-scope binding no longer matches the bundle baseline/policy",
    );
  }
  if (resolved.binding.schema_version !== GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery) {
    return blocked(
      "version_mismatch",
      `binding schema version ${resolved.binding.schema_version} is not the registered ${GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery}`,
    );
  }
  return resolved;
}

export async function runProjectDiscovery(
  deps: RunProjectDiscoveryDeps,
): Promise<ProjectDiscoveryOutcome> {
  const { projectRoot, bundle } = deps;

  // 1. Freshness: a drifted or invalidated bundle blocks before any call.
  if (bundle.project_baseline_digest !== deps.expectedProjectBaselineDigest) {
    return blocked(
      "bundle_stale",
      "the project baseline drifted since this bundle was compiled; recompile the context",
    );
  }
  if (isProjectContextBundleInvalidated(projectRoot, bundle.record_digest)) {
    return blocked("bundle_stale", "the bundle was invalidated by a recorded drift");
  }

  // 2. Capture-scope binding resolution (T2 records only).
  const resolved = resolveDiscoveryBinding(projectRoot, deps.profileDecisionDigest, bundle);
  if (!("binding" in resolved)) return resolved;
  const bindingRecordDigest = resolved.record.record_digest;

  // 3. Conversation/run identity: one conversation per (purpose, binding,
  //    bundle); a conversation already used by another purpose is an
  //    independence violation.
  const conversation_id = deriveGroundedConversationId({
    purpose: "project_discovery",
    binding_digest: bindingRecordDigest,
    bundle_digest: bundle.record_digest,
  });
  const input_digest = contentDigest({
    purpose: "project_discovery",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery,
    binding_digest: bindingRecordDigest,
    bundle_digest: bundle.record_digest,
    operator_intent: deps.operatorIntent ?? null,
  });
  const prior = readGroundedSynthesisRecords(projectRoot);
  const reused = prior.filter((record) => record.conversation_id === conversation_id);
  if (reused.some((record) => record.purpose !== "project_discovery")) {
    return blocked(
      "independence_violation",
      "the derived conversation identity was already used by another purpose",
    );
  }
  const replay = reused.find((record) => record.input_digest === input_digest);
  if (replay !== undefined) {
    // Idempotent resume: the same committed inputs return the sealed record
    // without a second provider call.
    const recommendation = discoveryRecommendationFromRecord(replay, bundle);
    if (recommendation.status === "rejected") {
      return blocked(recommendation.failure.code, recommendation.failure.summary);
    }
    return { status: "completed", record: replay, recommendation: recommendation.recommendation };
  }

  // 4. Compile the versioned input and run the port.
  const input: ProjectDiscoveryInput = {
    purpose: "project_discovery",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery,
    binding_digest: bindingRecordDigest,
    conversation_id,
    run_id: deriveGroundedRunId({ conversation_id, input_digest }),
    bundle,
    ...(deps.operatorIntent === undefined ? {} : { operator_intent: deps.operatorIntent }),
  };
  const inputValidation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("project-discovery-input", input);
  if (!inputValidation.valid) {
    return blocked(
      "invalid_output",
      `compiled discovery input failed its schema: ${inputValidation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  const result = await deps.port.synthesize(input);
  if (result.status === "failed") {
    return { status: "blocked", failure: result.failure };
  }

  // 5. Schema, purpose and citation validation against the current bundle.
  const output = result.output;
  if (output.purpose !== "project_discovery") {
    return blocked(
      "invalid_output",
      `adapter returned a ${String(output.purpose)} output for a project_discovery call`,
    );
  }
  const outputValidation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate(
    "project-discovery-output",
    output,
  );
  if (!outputValidation.valid) {
    return blocked(
      "invalid_output",
      `discovery output failed its schema: ${outputValidation.errors
        .map((error) => `${error.instancePath}: ${error.message}`)
        .join("; ")}`,
    );
  }
  const citationIssues = validateGroundedCitations(output, bundle);
  if (citationIssues.length > 0) {
    const first = citationIssues[0]!;
    return blocked(first.code, `${first.claim_path}: ${first.message}`);
  }

  // 6. Seal, persist, and expose only the advisory recommendation.
  let record: GroundedSynthesisRecord;
  try {
    record = createGroundedSynthesisRecord({
      purpose: "project_discovery",
      ...(deps.sessionId === undefined ? {} : { session_id: deps.sessionId }),
      profile_decision_digest: deps.profileDecisionDigest,
      binding_digest: bindingRecordDigest,
      bundle_digest: bundle.record_digest,
      conversation_id,
      run_id: input.run_id,
      input_digest,
      output: output as ProjectDiscoveryOutput,
    });
  } catch (error) {
    if (error instanceof SynthesisRecordError) {
      return blocked("invalid_output", error.message);
    }
    throw error;
  }
  appendGroundedSynthesisRecord(projectRoot, record);
  const recommendation = discoveryRecommendationFromRecord(record, bundle);
  if (recommendation.status === "rejected") {
    return blocked(recommendation.failure.code, recommendation.failure.summary);
  }
  return { status: "completed", record, recommendation: recommendation.recommendation };
}
