import {
  candidateDisposition,
  contentDigest,
  sealRecordEnvelope,
  shouldInvokeFeedbackAnalysis,
  validateFeedbackAnalysisOutput,
  type FeedbackAnalysisPort,
  type FeedbackAnalysisRca,
  type FeedbackAnalysisRecord,
  type ModelPortFailure,
  type ProjectContextBundleRecord,
} from "@universal-harness-internal/core";

export type FeedbackAnalysisDisposition = "router_consumable" | "requires_human_review";

export interface FeedbackAnalysisEvidence {
  readonly evidence_id: string;
  readonly finding_digest: string;
  readonly binding_digest: string;
  readonly analysis_record_digest: string;
  readonly output_digest: string;
  readonly disposition: FeedbackAnalysisDisposition;
}

export interface FeedbackAnalysisStore {
  find(findingDigest: string, bindingDigest: string): FeedbackAnalysisRecord | undefined;
  appendRecord(record: FeedbackAnalysisRecord): void | Promise<void>;
  appendEvidence(evidence: FeedbackAnalysisEvidence): void | Promise<void>;
}

export interface InMemoryFeedbackAnalysisStore extends FeedbackAnalysisStore {
  readonly records: readonly FeedbackAnalysisRecord[];
  readonly evidence: readonly FeedbackAnalysisEvidence[];
}

export function createInMemoryFeedbackAnalysisStore(): InMemoryFeedbackAnalysisStore {
  const records: FeedbackAnalysisRecord[] = [];
  const evidence: FeedbackAnalysisEvidence[] = [];
  return {
    get records() {
      return [...records];
    },
    get evidence() {
      return [...evidence];
    },
    find(findingDigest, bindingDigest) {
      return records.find(
        (record) =>
          record.finding_digest === findingDigest && record.binding_digest === bindingDigest,
      );
    },
    appendRecord(record) {
      if (this.find(record.finding_digest, record.binding_digest) === undefined) {
        records.push(record);
      }
    },
    appendEvidence(value) {
      if (
        !evidence.some((entry) => entry.analysis_record_digest === value.analysis_record_digest)
      ) {
        evidence.push(value);
      }
    },
  };
}

export interface FeedbackAnalysisRequest {
  readonly analysis_id: string;
  readonly evidence_id: string;
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly finding_digest: string;
  readonly binding_digest: string;
  readonly conversation_id: string;
  readonly run_id: string;
  readonly deterministic_rca: FeedbackAnalysisRca;
  readonly bundle: ProjectContextBundleRecord;
  readonly binding_required: boolean;
  readonly policy_requires_semantic_explanation?: boolean;
}

export type FeedbackAnalysisCoordinatorOutcome =
  | {
      readonly status: "deterministic_only";
      readonly deterministic_rca: FeedbackAnalysisRca;
      readonly reason: "deterministic_rca_authoritative" | "optional_provider_unavailable";
    }
  | {
      readonly status: "analyzed";
      readonly deterministic_rca: FeedbackAnalysisRca;
      readonly record: FeedbackAnalysisRecord;
      readonly disposition: FeedbackAnalysisDisposition;
      readonly replayed?: boolean;
    }
  | {
      readonly status: "blocked";
      readonly deterministic_rca: FeedbackAnalysisRca;
      readonly failure: ModelPortFailure;
    };

export interface FeedbackAnalysisCoordinator {
  analyzeFinding(input: FeedbackAnalysisRequest): Promise<FeedbackAnalysisCoordinatorOutcome>;
}

function dispositionOf(record: FeedbackAnalysisRecord): FeedbackAnalysisDisposition {
  return record.output.change_seed_candidates.some(
    (candidate) => candidateDisposition(candidate) === "requires_human_review",
  )
    ? "requires_human_review"
    : "router_consumable";
}

function providerRequired(): ModelPortFailure {
  return {
    code: "provider_required",
    summary: "feedback_analysis requires a bound provider for this profile",
    retryable: true,
  };
}

export function createFeedbackAnalysisCoordinator(dependencies: {
  readonly port?: FeedbackAnalysisPort;
  readonly store: FeedbackAnalysisStore;
}): FeedbackAnalysisCoordinator {
  return {
    async analyzeFinding(input): Promise<FeedbackAnalysisCoordinatorOutcome> {
      if (
        !shouldInvokeFeedbackAnalysis(input.deterministic_rca, {
          ...(input.policy_requires_semantic_explanation === undefined
            ? {}
            : {
                policy_requires_semantic_explanation: input.policy_requires_semantic_explanation,
              }),
        })
      ) {
        return {
          status: "deterministic_only",
          deterministic_rca: input.deterministic_rca,
          reason: "deterministic_rca_authoritative",
        };
      }
      const existing = dependencies.store.find(input.finding_digest, input.binding_digest);
      if (existing !== undefined) {
        return {
          status: "analyzed",
          deterministic_rca: input.deterministic_rca,
          record: existing,
          disposition: dispositionOf(existing),
          replayed: true,
        };
      }
      if (dependencies.port === undefined) {
        return input.binding_required
          ? {
              status: "blocked",
              deterministic_rca: input.deterministic_rca,
              failure: providerRequired(),
            }
          : {
              status: "deterministic_only",
              deterministic_rca: input.deterministic_rca,
              reason: "optional_provider_unavailable",
            };
      }
      const portInput = {
        purpose: "feedback_analysis" as const,
        schema_version: "feedback_analysis.v1" as const,
        binding_digest: input.binding_digest,
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        finding_digest: input.finding_digest,
        deterministic_rca: input.deterministic_rca,
        bundle: input.bundle,
      };
      const analyzed = await dependencies.port.analyze(portInput);
      if (analyzed.status === "failed") {
        return input.binding_required
          ? {
              status: "blocked",
              deterministic_rca: input.deterministic_rca,
              failure: analyzed.failure,
            }
          : {
              status: "deterministic_only",
              deterministic_rca: input.deterministic_rca,
              reason: "optional_provider_unavailable",
            };
      }
      const issues = validateFeedbackAnalysisOutput({
        output: analyzed.output,
        finding_digest: input.finding_digest,
        fact_digests: Object.fromEntries(
          input.bundle.sources.map((source) => [source.locator, source.source_digest]),
        ),
      });
      if (issues.length > 0) {
        const failure: ModelPortFailure = {
          code: "invalid_output",
          summary: `feedback analysis validation failed: ${issues
            .map((issue) => issue.code)
            .join(", ")}`,
          retryable: false,
        };
        return input.binding_required
          ? { status: "blocked", deterministic_rca: input.deterministic_rca, failure }
          : {
              status: "deterministic_only",
              deterministic_rca: input.deterministic_rca,
              reason: "optional_provider_unavailable",
            };
      }
      const record: FeedbackAnalysisRecord = sealRecordEnvelope({
        protocol_version: "1.1.0" as const,
        record_kind: "feedback_analysis" as const,
        analysis_id: input.analysis_id,
        workflow_operation_id: input.workflow_operation_id,
        iteration_id: input.iteration_id,
        finding_digest: input.finding_digest,
        binding_digest: input.binding_digest,
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        input_digest: contentDigest(portInput),
        output: analyzed.output,
      });
      const disposition = dispositionOf(record);
      await dependencies.store.appendRecord(record);
      await dependencies.store.appendEvidence({
        evidence_id: input.evidence_id,
        finding_digest: input.finding_digest,
        binding_digest: input.binding_digest,
        analysis_record_digest: record.record_digest,
        output_digest: contentDigest(record.output),
        disposition,
      });
      return {
        status: "analyzed",
        deterministic_rca: input.deterministic_rca,
        record,
        disposition,
      };
    },
  };
}
