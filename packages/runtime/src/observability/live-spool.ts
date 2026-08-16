import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
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
  let files: string[];
  try {
    files = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
  const events: ObservationEvent[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(directory, file), "utf8").split("\n")) {
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

function lastSequence(directory: string): number {
  return observations(directory).at(-1)?.sequence ?? 0;
}

export class FileLiveSpool {
  private readonly sequences = new Map<string, number>();

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
    const sequence = (this.sequences.get(input.streamId) ?? lastSequence(directory)) + 1;
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
    const current = observations(directory);
    let retained = current.slice(-maxRecords);
    const serialize = (events: readonly ObservationEvent[]): string =>
      `${events.map((record) => canonicalizeJson(record)).join("\n")}\n`;
    while (retained.length > 1 && Buffer.byteLength(serialize(retained)) > maxBytes) {
      retained = retained.slice(1);
    }
    if (retained.length !== current.length) {
      const temporary = `${segment}.tmp`;
      writeFileSync(temporary, serialize(retained), "utf8");
      renameSync(temporary, segment);
    }
    this.sequences.set(input.streamId, sequence);
    return event;
  }
}
