import type { RUN_OUTCOMES, TERMINATION_REASONS } from "@universal-harness-internal/core";

/**
 * Agent adapter port contract (design 13.2). An AgentAdapter declares its
 * capabilities, limits, usage metering, provider configuration and resume
 * support up front; it receives exactly one Task Envelope per run and returns
 * a structured run result: outcome, state proposal, change summary, tool
 * activity summary, usage, termination reason and evidence locators.
 *
 * The port is transport-agnostic and never trusts the provider: an automatic
 * adapter must either report usage or run under a Harness-enforced token
 * ceiling, and a delegated adapter whose manifest cannot prove metering,
 * interception, resume and trajectory coverage is forced into supervised
 * mode -- it must never run unattended. An adapter outcome is a claim; only
 * the Harness may mint a terminal `success` after evidence verification, so
 * this port never produces `success` itself.
 *
 * The envelope type below is a structural view: the runtime TaskEnvelope is
 * assignable to it, and adapters never receive authority beyond what the
 * envelope describes.
 */

export const AGENT_CONTROL_LEVELS = ["managed", "delegated", "manual"] as const;

export type AgentControlLevel = (typeof AGENT_CONTROL_LEVELS)[number];

export const AGENT_TRAJECTORY_VISIBILITIES = ["full", "summarized", "external-only"] as const;

export type AgentTrajectoryVisibility = (typeof AGENT_TRAJECTORY_VISIBILITIES)[number];

/**
 * Resume support an adapter can prove: `none` (a rerun loses all progress),
 * `explicit` (the Harness drives resume by re-handing the envelope plus prior
 * evidence) or `native` (the provider itself resumes an interrupted run).
 */
export const AGENT_RESUME_SEMANTICS = ["none", "explicit", "native"] as const;

export type AgentResumeSemantics = (typeof AGENT_RESUME_SEMANTICS)[number];

export type AgentRunOutcome = (typeof RUN_OUTCOMES)[number];

export type AgentTerminationReason = (typeof TERMINATION_REASONS)[number];

/** Control profile every adapter declares (design 13.2 table). */
export interface AgentControlProfile {
  readonly control: AgentControlLevel;
  readonly trajectory_visibility: AgentTrajectoryVisibility;
  readonly usage_metering: boolean;
  readonly side_effect_interception: boolean;
}

/** Provider configuration and capability declaration. */
export interface AgentProviderManifest extends AgentControlProfile {
  /** Stable provider identifier, e.g. `manual` or a coding-agent CLI name. */
  readonly provider: string;
  readonly resume_semantics: AgentResumeSemantics;
}

/**
 * Structural view of the runtime TaskEnvelope: the fields an adapter needs to
 * execute one task. The runtime envelope is assignable to this interface.
 */
export interface AgentTaskEnvelope {
  readonly task_id: string;
  readonly plan_id: string;
  readonly iteration_id: string;
  readonly repository_id: string;
  readonly objective: string;
  readonly expected_output: string;
  readonly acceptance_criteria: readonly string[];
  readonly allowed_read_paths: readonly string[];
  readonly proposed_write_paths: readonly string[];
  readonly state_proposal_fields: readonly string[];
  readonly baseline_commit: string;
  readonly input_digest: string;
  readonly digest: string;
  readonly loop_policy: {
    readonly max_steps: number;
    readonly max_tokens: number;
    readonly max_duration_ms: number;
  };
}

/** Pointer to externally stored evidence, bound by content digest. */
export interface AgentEvidenceLocator {
  /** Evidence kind, e.g. `transcript`, `diff`, `artifact` or `attestation`. */
  readonly kind: string;
  /** Path or URI the Harness can resolve. */
  readonly locator: string;
  /** SHA-256 hex digest of the referenced content. */
  readonly digest: string;
}

/**
 * Usage for one run. Token fields are `null` when the provider cannot meter
 * them; `metering` records which is the case so policy can refuse unmetered
 * automatic execution. `duration_ms` is always Harness-measured.
 */
export interface AgentUsage {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly duration_ms: number;
  readonly metering: "provider_reported" | "unmetered";
}

export interface AgentChangeSummary {
  readonly files_changed: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly paths: readonly string[];
}

/**
 * Tool activity summary. `governed_calls` counts only calls dispatched
 * through the Harness Tool Registry; the internal tools of an opaque
 * delegated provider are never reported as governed.
 */
export interface AgentToolActivitySummary {
  readonly total_calls: number;
  readonly governed_calls: number;
  readonly by_tool: Readonly<Record<string, number>>;
}

export interface AgentRunResult {
  readonly outcome: AgentRunOutcome;
  readonly termination_reason: AgentTerminationReason;
  /**
   * `true` when the agent or human claims the task is complete. This is only
   * a claim: the Harness verifies it against current mandatory evidence
   * before any terminal `success` exists.
   */
  readonly completion_claimed: boolean;
  readonly summary: string;
  /** Typed proposal, already filtered to the envelope's declared fields. */
  readonly state_proposal: Readonly<Record<string, unknown>> | null;
  /** Proposal keys the agent offered but the envelope did not declare. */
  readonly dropped_proposal_fields: readonly string[];
  readonly change_summary: AgentChangeSummary;
  readonly tool_activity: AgentToolActivitySummary;
  readonly usage: AgentUsage;
  readonly evidence: readonly AgentEvidenceLocator[];
  /** Paths the run changed outside the envelope's proposed write paths. */
  readonly undeclared_writes: readonly string[];
}

export const AGENT_RUN_MODES = ["supervised", "unattended"] as const;

export type AgentRunMode = (typeof AGENT_RUN_MODES)[number];

/** Explicit resume context: prior evidence and a human-supplied note. */
export interface AgentResumeContext {
  readonly note: string;
  readonly prior_evidence: readonly AgentEvidenceLocator[];
}

export interface AgentRunOptions {
  readonly mode: AgentRunMode;
  readonly resume?: AgentResumeContext;
}

export interface AgentAdapter {
  readonly name: string;
  readonly manifest: AgentProviderManifest;
  run(envelope: AgentTaskEnvelope, options: AgentRunOptions): Promise<AgentRunResult>;
}

export interface UnattendedAssessment {
  readonly eligible: boolean;
  /** Stable, human-readable reasons; empty when eligible. */
  readonly reasons: readonly string[];
}

/**
 * Decide whether a manifest proves enough control for unattended execution
 * (design 13.2, acceptance 14 and 23). Managed adapters own the loop and are
 * eligible. Delegated adapters must prove usage metering, side-effect
 * interception, at least summarized trajectory coverage and a working resume
 * semantic; anything less is forced into supervised mode. Manual adapters are
 * never unattended.
 */
export function assessUnattendedEligibility(manifest: AgentProviderManifest): UnattendedAssessment {
  const reasons: string[] = [];
  if (manifest.control === "manual") {
    reasons.push("manual adapters are never unattended: a human executes the task");
  } else if (manifest.control === "delegated") {
    if (!manifest.usage_metering) {
      reasons.push(
        "delegated provider does not prove usage metering; without it the Harness " +
          "cannot enforce a token ceiling",
      );
    }
    if (!manifest.side_effect_interception) {
      reasons.push("delegated provider does not prove side-effect interception");
    }
    if (manifest.trajectory_visibility === "external-only") {
      reasons.push(
        "delegated provider exposes no internal trajectory; external-only visibility " +
          "cannot satisfy trajectory coverage requirements",
      );
    }
    if (manifest.resume_semantics === "none") {
      reasons.push("delegated provider cannot resume an interrupted run");
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

export const AGENT_ERROR_KINDS = [
  "invalid_manifest",
  "invalid_envelope",
  "invalid_result",
  "invalid_handoff",
] as const;

export type AgentErrorKind = (typeof AGENT_ERROR_KINDS)[number];

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: AgentErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentError";
    this.kind = kind;
    if (details !== undefined) this.details = details;
  }
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export function isEvidenceDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/** Filter an agent-offered proposal to the envelope's declared fields. */
export function filterStateProposal(
  proposal: Readonly<Record<string, unknown>>,
  declaredFields: readonly string[],
): { readonly proposal: Record<string, unknown>; readonly dropped: readonly string[] } {
  const declared = new Set(declaredFields);
  const filtered: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(proposal)) {
    if (declared.has(key)) {
      filtered[key] = value;
    } else {
      dropped.push(key);
    }
  }
  dropped.sort();
  return { proposal: filtered, dropped };
}

/** `true` when `path` is exactly `declared` or inside it. */
export function isWithinDeclaredPath(declared: string, path: string): boolean {
  return path === declared || path.startsWith(`${declared}/`);
}
