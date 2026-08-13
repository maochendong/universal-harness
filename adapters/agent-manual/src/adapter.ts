import {
  AgentError,
  assessUnattendedEligibility,
  filterStateProposal,
  isEvidenceDigest,
  type AgentAdapter,
  type AgentEvidenceLocator,
  type AgentRunResult,
  type AgentTaskEnvelope,
} from "@universal-harness-internal/plugin-sdk";

/**
 * Manual AgentAdapter (design 13.2, control level `manual`). A human executes
 * the task outside the Harness and attaches evidence; the adapter's job is to
 * render a complete, self-contained handoff package from the Task Envelope,
 * validate the human's completion response and report a structured run
 * result. Manual runs are never unattended, and usage is unmetered -- budget
 * ceilings are advisory only, except for Harness-run tools which the Tool
 * Registry meters itself. Resume is explicit: a deferred run is resumed by
 * calling `run` again with an AgentResumeContext, which the adapter folds
 * into the next handoff package so nothing is silently lost.
 */

export const MANUAL_HANDOFF_STATUSES = ["completed", "blocked", "deferred"] as const;

export type ManualHandoffStatus = (typeof MANUAL_HANDOFF_STATUSES)[number];

/** The handoff package handed to the human channel. */
export interface ManualHandoffRequest {
  readonly envelope: AgentTaskEnvelope;
  /** Rendered, self-contained task brief. */
  readonly instructions: string;
  /** Present only on an explicit resume. */
  readonly resume: {
    readonly note: string;
    readonly prior_evidence: readonly AgentEvidenceLocator[];
  } | null;
}

export interface ManualHandoffResponse {
  readonly status: ManualHandoffStatus;
  readonly summary: string;
  /** Evidence the human attached; a completed handoff requires at least one. */
  readonly evidence: readonly AgentEvidenceLocator[];
  readonly state_proposal?: Readonly<Record<string, unknown>>;
  readonly change_summary?: {
    readonly files_changed: number;
    readonly insertions: number;
    readonly deletions: number;
    readonly paths: readonly string[];
  };
  /** Free-form note; carried into the resume context of a deferred run. */
  readonly note?: string;
}

export type ManualHandoffChannel = (
  request: ManualHandoffRequest,
) => Promise<ManualHandoffResponse>;

export interface ManualAgentAdapterOptions {
  readonly handoff: ManualHandoffChannel;
  /** Millisecond clock; fake in tests. */
  readonly clock?: () => number;
}

function renderInstructions(envelope: AgentTaskEnvelope): string {
  const lines = [
    `Task ${envelope.task_id} (plan ${envelope.plan_id}, iteration ${envelope.iteration_id})`,
    `Repository: ${envelope.repository_id} @ ${envelope.baseline_commit}`,
    "",
    "Objective:",
    envelope.objective,
    "",
    "Expected output:",
    envelope.expected_output,
    "",
    "Acceptance criteria:",
    ...envelope.acceptance_criteria.map((criterion) => `- ${criterion}`),
    "",
    `Allowed read paths: ${envelope.allowed_read_paths.join(", ") || "(none)"}`,
    `Proposed write paths: ${envelope.proposed_write_paths.join(", ") || "(none)"}`,
    `State proposal fields: ${envelope.state_proposal_fields.join(", ") || "(none)"}`,
    `Envelope digest: ${envelope.digest}`,
    `Input digest: ${envelope.input_digest}`,
  ];
  return lines.join("\n");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateEvidence(raw: unknown): AgentEvidenceLocator[] {
  if (!Array.isArray(raw)) {
    throw new AgentError("invalid_handoff", "handoff evidence must be an array");
  }
  return raw.map((entry, index) => {
    const locator = entry as AgentEvidenceLocator;
    if (
      typeof entry !== "object" ||
      entry === null ||
      !isNonEmptyString(locator.kind) ||
      !isNonEmptyString(locator.locator) ||
      !isEvidenceDigest(locator.digest)
    ) {
      throw new AgentError(
        "invalid_handoff",
        `handoff evidence entry ${String(index)} needs a kind, a locator and a SHA-256 digest`,
      );
    }
    return { kind: locator.kind, locator: locator.locator, digest: locator.digest };
  });
}

function validateResponse(raw: ManualHandoffResponse): ManualHandoffResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new AgentError("invalid_handoff", "handoff channel must return an object");
  }
  if (!(MANUAL_HANDOFF_STATUSES as readonly string[]).includes(raw.status)) {
    throw new AgentError(
      "invalid_handoff",
      `handoff status must be one of ${MANUAL_HANDOFF_STATUSES.join(", ")}`,
    );
  }
  if (!isNonEmptyString(raw.summary)) {
    throw new AgentError("invalid_handoff", "handoff response requires a non-empty summary");
  }
  const evidence = validateEvidence(raw.evidence);
  if (raw.status === "completed" && evidence.length === 0) {
    throw new AgentError(
      "invalid_handoff",
      "a completed manual handoff must attach at least one evidence locator",
    );
  }
  if (
    raw.state_proposal !== undefined &&
    (typeof raw.state_proposal !== "object" || raw.state_proposal === null)
  ) {
    throw new AgentError("invalid_handoff", "handoff state_proposal must be an object");
  }
  return { ...raw, evidence };
}

/**
 * Create the manual adapter. The handoff channel is the human interface (CLI
 * prompt, editor, ticket system); the adapter never executes anything itself.
 */
export function createManualAgentAdapter(options: ManualAgentAdapterOptions): AgentAdapter {
  const clock = options.clock ?? Date.now;
  const manifest: AgentAdapter["manifest"] = {
    provider: "manual",
    control: "manual",
    trajectory_visibility: "external-only",
    usage_metering: false,
    side_effect_interception: false,
    resume_semantics: "explicit",
  };

  return {
    name: "agent-manual",
    manifest,

    async run(envelope, runOptions): Promise<AgentRunResult> {
      const started = clock();
      const usage = {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        duration_ms: Math.max(0, clock() - started),
        metering: "unmetered" as const,
      };
      const emptyActivity = { total_calls: 0, governed_calls: 0, by_tool: {} };

      if (runOptions.mode === "unattended") {
        const assessment = assessUnattendedEligibility(manifest);
        return {
          outcome: "correct_block",
          termination_reason: "policy_denial",
          completion_claimed: false,
          summary: `unattended manual run refused: ${assessment.reasons.join("; ")}`,
          state_proposal: null,
          dropped_proposal_fields: [],
          change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
          tool_activity: emptyActivity,
          usage,
          evidence: [],
          undeclared_writes: [],
        };
      }

      const request: ManualHandoffRequest = {
        envelope,
        instructions: renderInstructions(envelope),
        resume:
          runOptions.resume === undefined
            ? null
            : { note: runOptions.resume.note, prior_evidence: runOptions.resume.prior_evidence },
      };

      let response: ManualHandoffResponse;
      try {
        response = validateResponse(await options.handoff(request));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          outcome: "failed",
          termination_reason: "adapter_failure",
          completion_claimed: false,
          summary: `manual handoff failed: ${message}`,
          state_proposal: null,
          dropped_proposal_fields: [],
          change_summary: { files_changed: 0, insertions: 0, deletions: 0, paths: [] },
          tool_activity: emptyActivity,
          usage: { ...usage, duration_ms: Math.max(0, clock() - started) },
          evidence: [],
          undeclared_writes: [],
        };
      }

      const filtered = filterStateProposal(
        response.state_proposal ?? {},
        envelope.state_proposal_fields,
      );
      const base = {
        summary: response.summary,
        state_proposal: Object.keys(filtered.proposal).length > 0 ? filtered.proposal : null,
        dropped_proposal_fields: filtered.dropped,
        change_summary: response.change_summary ?? {
          files_changed: 0,
          insertions: 0,
          deletions: 0,
          paths: [],
        },
        tool_activity: emptyActivity,
        usage: { ...usage, duration_ms: Math.max(0, clock() - started) },
        evidence: response.evidence,
        undeclared_writes: [],
      };

      if (response.status === "completed") {
        // A claim, not a success: the Harness verifies the attached evidence.
        return {
          ...base,
          outcome: "handoff",
          termination_reason: "completion",
          completion_claimed: true,
        };
      }
      if (response.status === "blocked") {
        return {
          ...base,
          outcome: "failed",
          termination_reason: "manual_stop",
          completion_claimed: false,
        };
      }
      return {
        ...base,
        outcome: "handoff",
        termination_reason: "manual_stop",
        completion_claimed: false,
      };
    },
  };
}
