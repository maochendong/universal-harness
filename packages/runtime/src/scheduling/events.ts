import { PROTOCOL_1_3_VERSION, contentDigest } from "@universal-harness-internal/core";

/**
 * Minimal M4 scheduler lifecycle event set (design §18, plan Task 8 step 6).
 * These eight builders are the only way scheduler events are shaped; each
 * returns a spec the caller commits alongside the authoritative records of
 * the same ledger transaction. Events are a timeline/observability aid — they
 * never replace Lease, Evidence or WaveIntegration authority.
 *
 * Redaction is part of the contract: every free-text field passes through
 * `redactSchedulerText` (absolute paths stripped, output bounded) and every
 * worktree reference is a digest locator, so no API key material, full
 * environment, raw transcript, approval reason or user home path can enter a
 * Live Spool or Event payload through these builders.
 */

export const SCHEDULER_EVENT_TYPES = [
  "TaskLeaseGranted",
  "TaskDispatched",
  "TaskIntegrationQueued",
  "TaskCandidateValidated",
  "TaskRetryScheduled",
  "WaveGateCompleted",
  "WaveIntegrated",
  "SchedulerRecovered",
] as const;

export type SchedulerEventType = (typeof SCHEDULER_EVENT_TYPES)[number];

export interface SchedulerEventSpec {
  readonly eventType: SchedulerEventType;
  /** M4 events pin protocol 1.3 so older readers fail closed. */
  readonly protocolVersion: string;
  readonly payload: Record<string, unknown>;
}

const REDACTED_PATH = "<redacted-path>";
const DEFAULT_OUTPUT_TAIL_MAX_BYTES = 4_096;

/**
 * Absolute filesystem paths never leave the scheduler boundary: any token
 * shaped like an absolute path (two or more segments) collapses to a fixed
 * placeholder. Over-redaction of e.g. URLs inside output is deliberate —
 * these strings are observational tails, not content the runtime acts on.
 */
const ABSOLUTE_PATH_PATTERN = /(?<![\w:/])\/(?:[^\s/"']+\/)+[^\s/"']*/gu;

/**
 * Windows absolute paths collapse the same way: a drive-letter or UNC prefix
 * followed by two or more segments, with `\` and `/` accepted as separators
 * interchangeably (Windows APIs and several tools mix them). The pattern only
 * fires on a drive/UNC prefix, so POSIX text is matched byte-identically by
 * the pattern above.
 */
const WINDOWS_ABSOLUTE_PATH_PATTERN =
  /(?<![\w:\\])(?:[A-Za-z]:[\\/]|\\\\)(?:[^\s\\/"']+[\\/])+[^\s\\"']*/gu;

/** Bound a string to its trailing `maxBytes` UTF-8 bytes (never splits a code point). */
export function boundOutputTail(text: string, maxBytes = DEFAULT_OUTPUT_TAIL_MAX_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let tail = "";
  for (const character of [...text].reverse()) {
    const candidate = character + tail;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) break;
    tail = candidate;
  }
  return tail;
}

/** Strip absolute paths from free text, then bound it to a tail of `maxBytes`. */
export function redactSchedulerText(
  text: string,
  maxBytes = DEFAULT_OUTPUT_TAIL_MAX_BYTES,
): string {
  return boundOutputTail(
    text
      .replace(ABSOLUTE_PATH_PATTERN, REDACTED_PATH)
      .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, REDACTED_PATH),
    maxBytes,
  );
}

/**
 * Digest-based worktree locator for live state and events: stable for one
 * root, reversible by nobody, and free of any absolute path.
 */
export function redactedWorktreeLocator(worktreeRoot: string): string {
  return `worktree_${contentDigest({ worktree_root: worktreeRoot }).slice(0, 12)}`;
}

export interface TaskLeaseGrantedDetails {
  readonly operation_id: string;
  readonly task_id: string;
  readonly lease_id: string;
  readonly slot_id: string;
  readonly fencing_token: number;
  readonly plan_digest: string;
}

export function taskLeaseGrantedEvent(details: TaskLeaseGrantedDetails): SchedulerEventSpec {
  return {
    eventType: "TaskLeaseGranted",
    protocolVersion: PROTOCOL_1_3_VERSION,
    payload: {
      operation_id: details.operation_id,
      task_id: details.task_id,
      lease_id: details.lease_id,
      slot_id: details.slot_id,
      fencing_token: details.fencing_token,
      plan_digest: details.plan_digest,
    },
  };
}

export interface TaskDispatchedDetails {
  readonly operation_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly slot_id: string;
  readonly attempt_number: number;
  readonly worktree_root: string;
}

export function taskDispatchedEvent(details: TaskDispatchedDetails): SchedulerEventSpec {
  return {
    eventType: "TaskDispatched",
    protocolVersion: PROTOCOL_1_3_VERSION,
    payload: {
      operation_id: details.operation_id,
      task_id: details.task_id,
      run_id: details.run_id,
      slot_id: details.slot_id,
      attempt_number: details.attempt_number,
      worktree_locator: redactedWorktreeLocator(details.worktree_root),
    },
  };
}

export interface TaskIntegrationQueuedDetails {
  readonly operation_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly patch_digest: string;
}

export function taskIntegrationQueuedEvent(
  details: TaskIntegrationQueuedDetails,
): SchedulerEventSpec {
  return {
    eventType: "TaskIntegrationQueued",
    protocolVersion: PROTOCOL_1_3_VERSION,
    payload: {
      operation_id: details.operation_id,
      task_id: details.task_id,
      run_id: details.run_id,
      patch_digest: details.patch_digest,
    },
  };
}

export interface TaskCandidateValidatedDetails {
  readonly operation_id: string;
  readonly task_id: string;
  readonly evidence_digests: readonly string[];
}

export function taskCandidateValidatedEvent(
  details: TaskCandidateValidatedDetails,
): SchedulerEventSpec {
  return {
    eventType: "TaskCandidateValidated",
    protocolVersion: PROTOCOL_1_3_VERSION,
    payload: {
      operation_id: details.operation_id,
      task_id: details.task_id,
      evidence_digests: [...details.evidence_digests].sort(),
    },
  };
}

export interface TaskRetryScheduledDetails {
  readonly operation_id: string;
  readonly task_id: string;
  readonly retry_kind: "executor_retry" | "integration_retry";
  readonly attempt_number: number;
  readonly reason: string;
}

export function taskRetryScheduledEvent(details: TaskRetryScheduledDetails): SchedulerEventSpec {
  return {
    eventType: "TaskRetryScheduled",
    protocolVersion: PROTOCOL_1_3_VERSION,
    payload: {
      operation_id: details.operation_id,
      task_id: details.task_id,
      retry_kind: details.retry_kind,
      attempt_number: details.attempt_number,
      reason: redactSchedulerText(details.reason),
    },
  };
}

export interface WaveGateCompletedDetails {
  readonly operation_id: string;
  readonly wave_index: number;
  readonly passed: boolean;
  readonly evidence_digests: readonly string[];
}

export function waveGateCompletedEvent(details: WaveGateCompletedDetails): SchedulerEventSpec {
  return {
    eventType: "WaveGateCompleted",
    protocolVersion: PROTOCOL_1_3_VERSION,
    payload: {
      operation_id: details.operation_id,
      wave_index: details.wave_index,
      passed: details.passed,
      evidence_digests: [...details.evidence_digests].sort(),
    },
  };
}

export interface WaveIntegratedDetails {
  readonly operation_id: string;
  readonly wave_index: number;
  readonly task_ids: readonly string[];
  readonly wave_integration_id: string;
  readonly candidate_commit: string;
}

export function waveIntegratedEvent(details: WaveIntegratedDetails): SchedulerEventSpec {
  return {
    eventType: "WaveIntegrated",
    protocolVersion: PROTOCOL_1_3_VERSION,
    payload: {
      operation_id: details.operation_id,
      wave_index: details.wave_index,
      task_ids: [...details.task_ids],
      wave_integration_id: details.wave_integration_id,
      candidate_commit: details.candidate_commit,
    },
  };
}

export interface SchedulerRecoveredDetails {
  readonly operation_id: string;
  readonly recovered_tasks: readonly string[];
  readonly released_leases: readonly string[];
  readonly note?: string;
}

export function schedulerRecoveredEvent(details: SchedulerRecoveredDetails): SchedulerEventSpec {
  return {
    eventType: "SchedulerRecovered",
    protocolVersion: PROTOCOL_1_3_VERSION,
    payload: {
      operation_id: details.operation_id,
      recovered_tasks: [...details.recovered_tasks].sort(),
      released_leases: [...details.released_leases].sort(),
      ...(details.note === undefined ? {} : { note: redactSchedulerText(details.note) }),
    },
  };
}
