import type {
  ImpactAdvisoryOutput,
  ImpactCandidate,
  ImpactClarificationQuestion,
  ImpactEdgeCandidate,
  ImpactMissingFact,
  ImpactRiskSignal,
  ModelPortFailure,
  NodeRecord,
} from "@universal-harness-internal/core";

import { validateImpactAdvisoryMerge } from "./advisory.js";
import type { ImpactEntry } from "./impact-set.js";

/**
 * ImpactAdvisoryPort (model advisory design section 6). The port is the only
 * semantic seam between the harness and an advising model: it receives the
 * deterministic ImpactSet plus its bound digests and returns additive
 * candidates only. An advisory that cannot merge cleanly with the
 * deterministic set fails closed — it is never partially applied.
 *
 * `createInMemoryImpactAdvisoryPort` is the deterministic test/reference
 * implementation: a script supplies the raw candidates and the port performs
 * the same merge validation a model-backed adapter performs, so runtime tests
 * exercise the exact failure semantics of production.
 */

/** Everything the advisor is bound to; every digest must match at merge time. */
export interface ImpactAdvisoryInput {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  /** Content digest of the deterministic ImpactSet being advised. */
  readonly impact_set_digest: string;
  readonly deterministic_entries: readonly ImpactEntry[];
  readonly nodes: readonly NodeRecord[];
  /** Accepted-PRD requirement/context-source id → content digest. */
  readonly requirement_digests: Readonly<Record<string, string>>;
  readonly rule_registry_version: string;
  readonly rule_registry_digest: string;
  readonly conversation_id: string;
  readonly run_id: string;
}

export type ImpactAdvisoryResult =
  | {
      readonly status: "proposed";
      readonly additions: readonly ImpactCandidate[];
      readonly edge_candidates: readonly ImpactEdgeCandidate[];
      readonly risk_signals: readonly ImpactRiskSignal[];
      readonly missing_facts: readonly ImpactMissingFact[];
      readonly questions: readonly ImpactClarificationQuestion[];
    }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly ImpactClarificationQuestion[];
    }
  | { readonly status: "failed"; readonly failure: ModelPortFailure };

export interface ImpactAdvisoryPort {
  readonly name: string;
  advise(input: ImpactAdvisoryInput): Promise<ImpactAdvisoryResult>;
}

/** The candidates a script/model returns; the set digest defaults to the input. */
export type ImpactAdvisoryScript = (input: ImpactAdvisoryInput) => Omit<
  ImpactAdvisoryOutput,
  "purpose" | "schema_version" | "impact_set_digest"
> & {
  readonly impact_set_digest?: string;
};

function invalidOutput(summary: string): ModelPortFailure {
  return { code: "invalid_output", summary, retryable: false };
}

export function createInMemoryImpactAdvisoryPort(script: ImpactAdvisoryScript): ImpactAdvisoryPort {
  return {
    name: "in-memory-impact-advisory",
    async advise(input) {
      const candidates = script(input);
      const output: ImpactAdvisoryOutput = {
        purpose: "impact_advisory",
        schema_version: "impact-advisory.v1",
        impact_set_digest: candidates.impact_set_digest ?? input.impact_set_digest,
        additions: candidates.additions,
        edge_candidates: candidates.edge_candidates,
        risk_signals: candidates.risk_signals,
        missing_facts: candidates.missing_facts,
        questions: candidates.questions,
      };
      const issues = validateImpactAdvisoryMerge({
        output,
        deterministic_entries: input.deterministic_entries,
        impact_set_digest: input.impact_set_digest,
        nodes: input.nodes,
        requirement_digests: input.requirement_digests,
        rule_registry_version: input.rule_registry_version,
        rule_registry_digest: input.rule_registry_digest,
      });
      if (issues.length > 0) {
        return {
          status: "failed",
          failure: invalidOutput(
            `advisory failed merge validation: ${issues.map((entry) => entry.code).join(", ")}`,
          ),
        };
      }
      // A question-only advisory is a clarification request, not a proposal.
      const proposesContent =
        output.additions.length > 0 ||
        output.edge_candidates.length > 0 ||
        output.risk_signals.length > 0 ||
        output.missing_facts.length > 0;
      if (!proposesContent && output.questions.length > 0) {
        return { status: "clarification_required", questions: output.questions };
      }
      return {
        status: "proposed",
        additions: output.additions,
        edge_candidates: output.edge_candidates,
        risk_signals: output.risk_signals,
        missing_facts: output.missing_facts,
        questions: output.questions,
      };
    },
  };
}
