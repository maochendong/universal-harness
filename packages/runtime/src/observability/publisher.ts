import { createHash, type Hash } from "node:crypto";

import { contentDigest, type ObservationEvent } from "@universal-harness-internal/core";

import { REDACTED_SECRET, redactSecretValues } from "../secrets/environment-reference.js";
import type { ObservationInput } from "./live-spool.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_OUTPUT_INTERVAL_MS = 2_000;
const DEFAULT_OUTPUT_BYTE_THRESHOLD = 8 * 1024;
const DEFAULT_SUMMARY_LINES = 20;
const DEFAULT_SUMMARY_BYTES = 4 * 1024;

export interface ObservationSink {
  append(input: ObservationInput): ObservationEvent;
}

export interface ObservationStreamIdentity {
  readonly projectId: string;
  readonly iterationId: string;
  readonly workflowOperationId: string;
  readonly attemptId: string;
}

export interface ObservationPublisherOptions {
  readonly now?: () => string;
  readonly nowMs?: () => number;
  /** The same resolved values supplied to Tool invocation redaction. */
  readonly secrets?: ReadonlyMap<string, string>;
  readonly heartbeatIntervalMs?: number;
  readonly outputIntervalMs?: number;
  readonly outputByteThreshold?: number;
  readonly maxSummaryLines?: number;
  readonly maxSummaryBytes?: number;
}

export interface RunOutputOptions {
  readonly flush?: boolean;
}

export interface ObservationPublisherPort {
  phaseStarted(phase: string): ObservationEvent;
  phaseCompleted(phase: string): ObservationEvent;
  phasePaused(phase: string, status: string): ObservationEvent;
  gateStarted(gateId: string): ObservationEvent;
  gateCompleted(gateId: string, payload: Record<string, unknown>): ObservationEvent;
  runStarted(runId: string, payload?: Record<string, unknown>): ObservationEvent;
  runHeartbeat(runId: string, payload?: Record<string, unknown>): ObservationEvent | undefined;
  runOutput(runId: string, chunk: string, options?: RunOutputOptions): ObservationEvent | undefined;
  runTerminated(runId: string, payload?: Record<string, unknown>): ObservationEvent;
  budgetUpdated(payload: Record<string, unknown>): ObservationEvent;
  approvalRequired(payload: Record<string, unknown>): ObservationEvent;
}

interface OutputState {
  readonly hash: Hash;
  rawTail: string;
  totalBytes: number;
  pendingBytes: number;
  lastPublishedAt: number;
}

function logicalKey(kind: string, parts: readonly string[]): string {
  return `observation_${kind}_${contentDigest(parts).slice(0, 32)}`;
}

/** Shared key used by the live Gate result and its later authoritative Ledger event. */
export function gateCompletionObservationKey(
  workflowOperationId: string,
  attemptId: string,
  gateId: string,
): string {
  return logicalKey("gate_completed", [workflowOperationId, attemptId, gateId]);
}

function streamId(identity: ObservationStreamIdentity): string {
  return `stream_${contentDigest([identity.workflowOperationId, identity.attemptId]).slice(0, 32)}`;
}

function redactCommonCredentials(text: string): string {
  return text
    .replace(
      /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
      (_match, scheme: string) => `${scheme}${REDACTED_SECRET}@`,
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, `$1${REDACTED_SECRET}`)
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/gu,
      REDACTED_SECRET,
    );
}

function redactSecretPrefixAtBoundary(text: string, secrets: ReadonlyMap<string, string>): string {
  let result = text;
  for (const secret of secrets.values()) {
    const maximum = Math.min(secret.length - 1, result.length);
    for (let length = maximum; length >= 4; length -= 1) {
      if (!result.endsWith(secret.slice(0, length))) continue;
      result = `${result.slice(0, -length)}${REDACTED_SECRET}`;
      break;
    }
  }
  return result;
}

function boundedTail(
  raw: string,
  maxLines: number,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const lines = raw.split("\n");
  const selected = lines.slice(-maxLines).join("\n");
  if (Buffer.byteLength(selected, "utf8") <= maxBytes) {
    return { value: selected, truncated: lines.length > maxLines };
  }
  let value = "";
  for (const character of [...selected].reverse()) {
    if (Buffer.byteLength(character + value, "utf8") > maxBytes) break;
    value = character + value;
  }
  return { value, truncated: true };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Lossy live-observation publisher. It never writes authoritative state and
 * may be deleted or fail independently of resume, audit and snapshot state.
 */
export class ObservationPublisher implements ObservationPublisherPort {
  private readonly streamId: string;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly secrets: ReadonlyMap<string, string>;
  private readonly heartbeatIntervalMs: number;
  private readonly outputIntervalMs: number;
  private readonly outputByteThreshold: number;
  private readonly maxSummaryLines: number;
  private readonly maxSummaryBytes: number;
  private readonly heartbeatAt = new Map<string, number>();
  private readonly outputs = new Map<string, OutputState>();

  constructor(
    private readonly sink: ObservationSink,
    private readonly identity: ObservationStreamIdentity,
    options: ObservationPublisherOptions = {},
  ) {
    this.streamId = streamId(identity);
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? Date.now;
    this.secrets = options.secrets ?? new Map();
    this.heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    this.outputIntervalMs = positiveInteger(
      options.outputIntervalMs ?? DEFAULT_OUTPUT_INTERVAL_MS,
      "outputIntervalMs",
    );
    this.outputByteThreshold = positiveInteger(
      options.outputByteThreshold ?? DEFAULT_OUTPUT_BYTE_THRESHOLD,
      "outputByteThreshold",
    );
    this.maxSummaryLines = positiveInteger(
      options.maxSummaryLines ?? DEFAULT_SUMMARY_LINES,
      "maxSummaryLines",
    );
    this.maxSummaryBytes = positiveInteger(
      options.maxSummaryBytes ?? DEFAULT_SUMMARY_BYTES,
      "maxSummaryBytes",
    );
  }

  private publish(
    eventType: ObservationEvent["event_type"],
    observationKey: string,
    payload: Record<string, unknown>,
  ): ObservationEvent {
    return this.sink.append({
      streamId: this.streamId,
      observationKey,
      eventType,
      projectId: this.identity.projectId,
      iterationId: this.identity.iterationId,
      workflowOperationId: this.identity.workflowOperationId,
      timestamp: this.now(),
      payload: redactSecretValues(payload, this.secrets),
    });
  }

  phaseStarted(phase: string): ObservationEvent {
    return this.publish(
      "PhaseStarted",
      logicalKey("phase_started", [this.identity.attemptId, phase]),
      { phase, attempt_id: this.identity.attemptId },
    );
  }

  phaseCompleted(phase: string): ObservationEvent {
    return this.publish(
      "PhaseCompleted",
      logicalKey("phase_completed", [this.identity.attemptId, phase]),
      { phase, attempt_id: this.identity.attemptId },
    );
  }

  phasePaused(phase: string, status: string): ObservationEvent {
    return this.publish(
      "PhasePaused",
      logicalKey("phase_paused", [this.identity.attemptId, phase, status]),
      { phase, status, attempt_id: this.identity.attemptId },
    );
  }

  gateStarted(gateId: string): ObservationEvent {
    return this.publish(
      "GateStarted",
      logicalKey("gate_started", [this.identity.attemptId, gateId]),
      { gate_id: gateId, attempt_id: this.identity.attemptId },
    );
  }

  gateCompleted(gateId: string, payload: Record<string, unknown>): ObservationEvent {
    return this.publish(
      "GateCompleted",
      gateCompletionObservationKey(
        this.identity.workflowOperationId,
        this.identity.attemptId,
        gateId,
      ),
      { gate_id: gateId, attempt_id: this.identity.attemptId, ...payload },
    );
  }

  runStarted(runId: string, payload: Record<string, unknown> = {}): ObservationEvent {
    const now = this.nowMs();
    this.outputs.set(runId, {
      hash: createHash("sha256"),
      rawTail: "",
      totalBytes: 0,
      pendingBytes: 0,
      lastPublishedAt: now,
    });
    this.heartbeatAt.delete(runId);
    return this.publish("RunStarted", logicalKey("run_started", [runId]), {
      run_id: runId,
      attempt_id: this.identity.attemptId,
      ...payload,
    });
  }

  runHeartbeat(runId: string, payload: Record<string, unknown> = {}): ObservationEvent | undefined {
    const now = this.nowMs();
    const previous = this.heartbeatAt.get(runId);
    if (previous !== undefined && now - previous < this.heartbeatIntervalMs) return undefined;
    this.heartbeatAt.set(runId, now);
    return this.publish("RunHeartbeat", logicalKey("run_heartbeat", [runId, String(now)]), {
      run_id: runId,
      ...payload,
    });
  }

  runOutput(
    runId: string,
    chunk: string,
    options: RunOutputOptions = {},
  ): ObservationEvent | undefined {
    const state = this.outputs.get(runId);
    if (state === undefined) throw new Error(`run ${runId} must start before publishing output`);
    const bytes = Buffer.byteLength(chunk, "utf8");
    state.hash.update(chunk, "utf8");
    state.rawTail += chunk;
    state.totalBytes += bytes;
    state.pendingBytes += bytes;
    const now = this.nowMs();
    if (
      options.flush !== true &&
      state.pendingBytes < this.outputByteThreshold &&
      now - state.lastPublishedAt < this.outputIntervalMs
    ) {
      return undefined;
    }
    const bounded = boundedTail(state.rawTail, this.maxSummaryLines, this.maxSummaryBytes);
    const boundarySafe =
      options.flush === true
        ? bounded.value
        : redactSecretPrefixAtBoundary(bounded.value, this.secrets);
    const scrubbed = boundedTail(
      redactCommonCredentials(boundarySafe),
      this.maxSummaryLines,
      this.maxSummaryBytes,
    );
    state.pendingBytes = 0;
    state.lastPublishedAt = now;
    // Retain a bounded raw tail so secrets or credentials split across chunks
    // are scrubbed after the next chunk joins the same summary window.
    state.rawTail = bounded.value;
    return this.publish(
      "RunOutputSummary",
      logicalKey("run_output", [runId, String(state.totalBytes)]),
      {
        run_id: runId,
        summary: scrubbed.value,
        output_digest: state.hash.copy().digest("hex"),
        bytes_observed: state.totalBytes,
        truncated: bounded.truncated || scrubbed.truncated,
      },
    );
  }

  budgetUpdated(payload: Record<string, unknown>): ObservationEvent {
    return this.publish(
      "BudgetUpdated",
      logicalKey("budget_updated", [this.identity.attemptId, contentDigest(payload)]),
      payload,
    );
  }

  runTerminated(runId: string, payload: Record<string, unknown> = {}): ObservationEvent {
    this.heartbeatAt.delete(runId);
    this.outputs.delete(runId);
    return this.publish("RunTerminated", logicalKey("run_terminated", [runId]), {
      run_id: runId,
      ...payload,
    });
  }

  approvalRequired(payload: Record<string, unknown>): ObservationEvent {
    const requestId = typeof payload["request_id"] === "string" ? payload["request_id"] : "unknown";
    return this.publish(
      "ApprovalRequired",
      logicalKey("approval_required", [this.identity.attemptId, requestId]),
      payload,
    );
  }
}
