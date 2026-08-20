import type {
  DesignCoverageAssessment,
  DesignProposalQuestion,
  DesignResidualRisk,
  DesignReviewDraft,
  DesignReviewFinding,
  DesignReviewVerdict,
  DesignSetContent,
  ModelPortFailure,
  ProjectContextSource,
} from "../schema/index.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../schema/registry.js";
import { validateDesignReviewOutput } from "./review-validator.js";

/**
 * The design ports (designset lifecycle design 6.2/6.5, model advisory
 * design 6/7, plan T12). They are the only semantic seams between the
 * Harness and design models. A port never receives project or ledger write
 * capability, never mints identities and never approves; it returns
 * structured content, clarification questions or a typed failure. The
 * in-memory adapters run the exact production parse and validation path so
 * tests exercise real failure semantics; the manual adapter fabricates
 * nothing.
 */
export interface DesignProposalInput {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly requirement_baseline_digest: string;
  readonly impact_set_id: string;
  readonly impact_set_digest: string;
  readonly policy_digest: string;
  readonly repository_baseline: string;
  readonly must_change_requirement_ids: readonly string[];
  readonly requirement_impact_risks: Readonly<Record<string, "low" | "medium" | "high">>;
  readonly criterion_test_pairs: readonly {
    readonly requirement_id: string;
    readonly acceptance_criterion_id: string;
    readonly test_node_id: string;
  }[];
  /** Controlled, untrusted-marked context sources of the proposal bundle. */
  readonly sources: readonly ProjectContextSource[];
  readonly bundle_digest: string;
  readonly conversation_id: string;
  readonly run_id: string;
}

export type DesignProposalResult =
  | {
      readonly status: "proposed";
      readonly proposal: DesignSetContent;
      readonly questions: readonly DesignProposalQuestion[];
    }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly DesignProposalQuestion[];
    }
  | { readonly status: "failed"; readonly failure: ModelPortFailure };

export interface DesignProposalPort {
  readonly name: string;
  propose(input: DesignProposalInput): Promise<DesignProposalResult>;
}

/** The review rubric: the finding categories the reviewer must assess. */
export interface DesignReviewRubric {
  readonly rubric_id: string;
  readonly categories: readonly string[];
}

export interface DesignReviewInput {
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly proposal_content: DesignSetContent;
  readonly proposal_digest: string;
  readonly validation_digest: string;
  /** Citable sources of the independent review bundle. */
  readonly bundle_sources: readonly { readonly ref: string; readonly digest: string }[];
  readonly bundle_digest: string;
  readonly rubric: DesignReviewRubric;
  readonly must_change_requirement_ids: readonly string[];
  readonly conversation_id: string;
  readonly run_id: string;
}

export type DesignReviewResult =
  | {
      readonly status: DesignReviewVerdict;
      readonly findings: readonly DesignReviewFinding[];
      readonly coverage_assessment: readonly DesignCoverageAssessment[];
      readonly residual_risks: readonly DesignResidualRisk[];
      readonly summary: string;
    }
  | { readonly status: "failed"; readonly failure: ModelPortFailure };

export interface DesignReviewPort {
  readonly name: string;
  review(input: DesignReviewInput): Promise<DesignReviewResult>;
}

function invalidOutput(summary: string): ModelPortFailure {
  return { code: "invalid_output", summary, retryable: false };
}

/** Parse an untrusted raw proposal payload into the typed port result. */
export function parseDesignProposalOutput(raw: unknown): DesignProposalResult {
  const shape = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-proposal-output", raw);
  if (!shape.valid) {
    return {
      status: "failed",
      failure: invalidOutput(
        `design proposal output failed schema validation: ${shape.errors[0]?.message ?? "unknown"}`,
      ),
    };
  }
  const output = raw as { proposal?: DesignSetContent; questions?: DesignProposalQuestion[] };
  const questions = output.questions ?? [];
  if (output.proposal !== undefined) {
    return { status: "proposed", proposal: output.proposal, questions };
  }
  if (questions.length > 0) {
    return { status: "clarification_required", questions };
  }
  return {
    status: "failed",
    failure: invalidOutput("design proposal output carries neither a proposal nor questions"),
  };
}

/** A script supplies the raw payload; the port parses it like a model's. */
export function createInMemoryDesignProposalPort(
  script: (input: DesignProposalInput) => unknown,
): DesignProposalPort {
  return {
    name: "in-memory-design-proposal",
    async propose(input) {
      const payload = script(input);
      const wrapped =
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? { purpose: "design_proposal", schema_version: "design_proposal.v1", ...payload }
          : payload;
      return parseDesignProposalOutput(wrapped);
    },
  };
}

/** The manual port never fabricates: no supplied proposal means clarify. */
export function createManualDesignProposalPort(options?: {
  readonly proposal?: (input: DesignProposalInput) => DesignSetContent;
}): DesignProposalPort {
  return {
    name: "manual-design-proposal",
    async propose(input) {
      if (options?.proposal === undefined) {
        return {
          status: "clarification_required",
          questions: [{ question: "manual design proposal input required" }],
        };
      }
      return { status: "proposed", proposal: options.proposal(input), questions: [] };
    },
  };
}

/** A script supplies the raw draft; the port validates it like a model's. */
export function createInMemoryDesignReviewPort(
  script: (input: DesignReviewInput) => unknown,
): DesignReviewPort {
  return {
    name: "in-memory-design-review",
    async review(input) {
      const payload = script(input);
      const wrapped =
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? { purpose: "design_review", schema_version: "design_review.v1", ...payload }
          : payload;
      const shape = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-review-output", wrapped);
      if (!shape.valid) {
        return {
          status: "failed",
          failure: invalidOutput(
            `design review output failed schema validation: ${shape.errors[0]?.message ?? "unknown"}`,
          ),
        };
      }
      const draft = wrapped as DesignReviewDraft;
      const issues = validateDesignReviewOutput({
        output: draft,
        bundle_sources: input.bundle_sources,
        proposal_content: input.proposal_content,
        must_change_requirement_ids: input.must_change_requirement_ids,
      });
      if (issues.length > 0) {
        return {
          status: "failed",
          failure: invalidOutput(
            `design review failed result validation: ${issues.map((entry) => entry.code).join(", ")}`,
          ),
        };
      }
      return {
        status: draft.verdict,
        findings: draft.findings,
        coverage_assessment: draft.coverage_assessment,
        residual_risks: draft.residual_risks,
        summary: draft.summary,
      };
    },
  };
}
