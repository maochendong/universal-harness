import { sha256Hex } from "@universal-harness-internal/core";

export type LiveBlockerKind = "approval" | "task_run" | "finding" | "recovery" | "other";

export interface LiveBlocker {
  readonly kind: LiveBlockerKind;
  readonly subject_id?: string;
  /** Stable typed identity used for reconciliation; never a display-string key. */
  readonly identity: string;
  /** Compatibility projection consumed by existing checkpoints and CLIs. */
  readonly message: string;
  readonly digest: string;
}

export interface LiveBlockerReconciliationInput {
  readonly blocker_messages?: readonly string[];
  readonly pending_approval_ids?: readonly string[];
  readonly resolved_approval_ids?: readonly string[];
  readonly passed_task_ids?: readonly string[];
  readonly blocking_finding_ids?: readonly string[];
  readonly inactive_finding_ids?: readonly string[];
  readonly terminal_iteration?: boolean;
}

const APPROVAL = /^approval request (\S+) awaiting a decision$/;
const TASK_RUN = /^task (\S+) did not complete:/;
const FINDING = /^blocking finding (\S+)$/;
const RECOVERY = /^recovered from an interrupted process/;

function blocker(kind: LiveBlockerKind, message: string, subjectId?: string): LiveBlocker {
  const identity =
    subjectId === undefined ? `${kind}:${sha256Hex(message).slice(0, 24)}` : `${kind}:${subjectId}`;
  return {
    kind,
    ...(subjectId === undefined ? {} : { subject_id: subjectId }),
    identity,
    message,
    digest: sha256Hex(`${identity}\n${message}`),
  };
}

function parseLegacyBlocker(message: string): LiveBlocker {
  const approval = APPROVAL.exec(message)?.[1];
  if (approval !== undefined) return blocker("approval", message, approval);
  const task = TASK_RUN.exec(message)?.[1];
  if (task !== undefined) return blocker("task_run", message, task);
  const finding = FINDING.exec(message)?.[1];
  if (finding !== undefined) return blocker("finding", message, finding);
  if (RECOVERY.test(message)) return blocker("recovery", message);
  return blocker("other", message);
}

/**
 * Pure lifecycle projection shared by WorkingState, Snapshot and status.
 * Historical strings remain readable, while typed subject identities decide
 * whether a blocker is still live.
 */
export function reconcileLiveBlockers(input: LiveBlockerReconciliationInput): LiveBlocker[] {
  const pendingApprovals = new Set(input.pending_approval_ids ?? []);
  const resolvedApprovals = new Set(input.resolved_approval_ids ?? []);
  const passedTasks = new Set(input.passed_task_ids ?? []);
  const inactiveFindings = new Set(input.inactive_finding_ids ?? []);
  const live = new Map<string, LiveBlocker>();

  for (const message of input.blocker_messages ?? []) {
    const candidate = parseLegacyBlocker(message);
    if (
      candidate.kind === "approval" &&
      candidate.subject_id !== undefined &&
      (resolvedApprovals.has(candidate.subject_id) ||
        (pendingApprovals.size > 0 && !pendingApprovals.has(candidate.subject_id)))
    ) {
      continue;
    }
    if (
      candidate.kind === "task_run" &&
      candidate.subject_id !== undefined &&
      passedTasks.has(candidate.subject_id)
    ) {
      continue;
    }
    if (
      candidate.kind === "finding" &&
      candidate.subject_id !== undefined &&
      inactiveFindings.has(candidate.subject_id)
    ) {
      continue;
    }
    if (candidate.kind === "recovery" && input.terminal_iteration === true) continue;
    live.set(candidate.identity, candidate);
  }

  for (const requestId of pendingApprovals) {
    const candidate = blocker(
      "approval",
      `approval request ${requestId} awaiting a decision`,
      requestId,
    );
    live.set(candidate.identity, candidate);
  }
  for (const findingId of input.blocking_finding_ids ?? []) {
    if (inactiveFindings.has(findingId)) continue;
    const candidate = blocker("finding", `blocking finding ${findingId}`, findingId);
    live.set(candidate.identity, candidate);
  }

  return [...live.values()].sort((left, right) =>
    left.message < right.message ? -1 : left.message > right.message ? 1 : 0,
  );
}

export function liveBlockerMessages(input: LiveBlockerReconciliationInput): string[] {
  return reconcileLiveBlockers(input).map((candidate) => candidate.message);
}
