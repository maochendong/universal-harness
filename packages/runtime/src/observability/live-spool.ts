import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import {
  canonicalizeJson,
  validateSchema,
  type ObservationEvent,
} from "@universal-harness-internal/core";

import { redactSecretValues } from "../secrets/environment-reference.js";

export interface ObservationInput {
  readonly streamId: string;
  readonly observationKey: string;
  readonly eventType: ObservationEvent["event_type"];
  readonly projectId: string;
  readonly iterationId: string;
  readonly workflowOperationId: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

export class LiveSpoolError extends Error {
  readonly kind = "live_spool_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "LiveSpoolError";
  }
}

export interface LiveSpoolOptions {
  readonly secrets?: ReadonlyMap<string, string>;
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}

function observations(directory: string): ObservationEvent[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".jsonl")) files.push(path);
      }
    } catch {
      // A missing or concurrently rotated spool is simply empty live state.
    }
  };
  visit(directory);
  files.sort();
  const events: ObservationEvent[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line === "") continue;
      try {
        const record = JSON.parse(line) as unknown;
        if (validateSchema("observation", record).valid) {
          events.push(record as ObservationEvent);
        }
      } catch {
        // Ignore incomplete cache tails; authoritative state never depends on them.
      }
    }
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}

export function readLiveObservations(projectRoot: string): ObservationEvent[] {
  return observations(join(projectRoot, ".harness", "cache", "event-stream"));
}

interface RetainedObservation {
  readonly event: ObservationEvent;
  readonly encoded: string;
  readonly bytes: number;
}
interface SpoolState {
  signature: string;
  sequence: number;
  records: RetainedObservation[];
  bytes: number;
}

function signature(directory: string): string {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => {
        const stat = statSync(join(directory, name));
        return `${name}:${String(stat.dev)}:${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`;
      })
      .join("|");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return "";
    throw error;
  }
}

function retained(event: ObservationEvent): RetainedObservation {
  const encoded = `${canonicalizeJson(event)}\n`;
  return { event, encoded, bytes: Buffer.byteLength(encoded) };
}

export class FileLiveSpool {
  private readonly states = new Map<string, SpoolState>();

  constructor(
    private readonly projectRoot: string,
    private readonly options: LiveSpoolOptions = {},
  ) {}

  append(input: ObservationInput): ObservationEvent {
    const maxRecords = this.options.maxRecords ?? 10_000;
    const maxBytes = this.options.maxBytes ?? 10 * 1024 * 1024;
    if (!Number.isInteger(maxRecords) || maxRecords < 1) {
      throw new LiveSpoolError("maxRecords must be a positive integer");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new LiveSpoolError("maxBytes must be a positive integer");
    }
    const directory = join(this.projectRoot, ".harness", "cache", "event-stream", input.streamId);
    const currentSignature = signature(directory);
    let state = this.states.get(input.streamId);
    if (state === undefined || state.signature !== currentSignature) {
      const records = observations(directory).map(retained);
      state = {
        signature: currentSignature,
        records,
        bytes: records.reduce((total, record) => total + record.bytes, 0),
        sequence: Math.max(state?.sequence ?? 0, records.at(-1)?.event.sequence ?? 0),
      };
      this.states.set(input.streamId, state);
    }
    const sequence = state.sequence + 1;
    const event: ObservationEvent = {
      stream_version: 1,
      stream_id: input.streamId,
      sequence,
      observation_key: input.observationKey,
      event_type: input.eventType,
      project_id: input.projectId,
      iteration_id: input.iterationId,
      workflow_operation_id: input.workflowOperationId,
      timestamp: input.timestamp,
      payload: redactSecretValues(input.payload, this.options.secrets ?? new Map()),
    };
    const validation = validateSchema("observation", event);
    if (!validation.valid) {
      throw new LiveSpoolError(
        `invalid observation: ${validation.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    const encodedEvent = `${canonicalizeJson(event)}\n`;
    if (Buffer.byteLength(encodedEvent) > maxBytes) {
      throw new LiveSpoolError(`observation exceeds maxBytes (${String(maxBytes)})`);
    }
    mkdirSync(directory, { recursive: true });
    const segment = join(directory, "segment-000001.jsonl");
    appendFileSync(segment, encodedEvent, "utf8");
    state.records.push({ event, encoded: encodedEvent, bytes: Buffer.byteLength(encodedEvent) });
    state.bytes += Buffer.byteLength(encodedEvent);
    let removed = 0;
    while (
      state.records.length - removed > 1 &&
      (state.records.length - removed > maxRecords || state.bytes > maxBytes)
    ) {
      state.bytes -= state.records[removed]!.bytes;
      removed += 1;
    }
    if (removed > 0) {
      state.records = state.records.slice(removed);
      const temporary = `${segment}.tmp`;
      writeFileSync(temporary, state.records.map((record) => record.encoded).join(""), "utf8");
      renameSync(temporary, segment);
    }
    state.signature = signature(directory);
    state.sequence = sequence;
    return event;
  }
}
