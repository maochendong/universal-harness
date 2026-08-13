import { contentDigest } from "@universal-harness-internal/core";

import type { RepeatDetectionPolicy } from "./policy.js";

/**
 * Repeat detection (design 13.3). Every tool call is fingerprinted over the
 * tool name, its normalized parameters and the target resource; each
 * observation also carries the digest of the related WorkingState and the
 * digest of the accumulated evidence. A call that repeats inside the sliding
 * window while neither state nor evidence has progressed terminates the
 * loop. Detection is always on -- LoopPolicy exposes no switch to disable it.
 */

/** A tool call as the model requested it, parameters already plain JSON. */
export interface NormalizedToolCall {
  readonly tool: string;
  readonly parameters: Record<string, unknown>;
  readonly resource?: string;
}

/**
 * Content digest of the normalized call. Canonical JSON makes key order
 * irrelevant, so logically identical calls always share a fingerprint.
 */
export function actionFingerprint(call: NormalizedToolCall): string {
  return contentDigest({
    tool: call.tool,
    parameters: call.parameters,
    resource: call.resource ?? null,
  });
}

export interface RepeatObservation {
  readonly fingerprint: string;
  /** Digest of the WorkingState committed after the call. */
  readonly state_digest: string;
  /** Digest of the ordered evidence digests accumulated so far. */
  readonly evidence_digest: string;
}

export interface RepeatDetectionResult {
  readonly repeated: boolean;
  /** Stagnant occurrences of the latest fingerprint inside the window. */
  readonly occurrences: number;
  readonly fingerprint?: string;
}

/**
 * Sliding-window stagnation detector. An observation is stagnant when the
 * same action fingerprint recurs with an unchanged (state, evidence) pair:
 * the call repeated and nothing progressed. `identical_action_limit`
 * stagnant occurrences of the newest observation inside the window trip the
 * detector.
 */
export class RepeatDetector {
  private readonly window: number;
  private readonly limit: number;
  private readonly observations: RepeatObservation[] = [];

  constructor(policy: RepeatDetectionPolicy) {
    this.window = policy.window;
    this.limit = policy.identical_action_limit;
  }

  get size(): number {
    return this.observations.length;
  }

  observe(observation: RepeatObservation): RepeatDetectionResult {
    this.observations.push(observation);
    if (this.observations.length > this.window) {
      this.observations.splice(0, this.observations.length - this.window);
    }
    const latest = observation;
    const occurrences = this.observations.filter(
      (candidate) =>
        candidate.fingerprint === latest.fingerprint &&
        candidate.state_digest === latest.state_digest &&
        candidate.evidence_digest === latest.evidence_digest,
    ).length;
    const repeated = occurrences >= this.limit;
    return {
      repeated,
      occurrences,
      ...(repeated ? { fingerprint: latest.fingerprint } : {}),
    };
  }
}
