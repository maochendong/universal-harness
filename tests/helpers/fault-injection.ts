import { readFileSync, writeFileSync } from "node:fs";

import type {
  BoundaryContext,
  CommitHooks,
  DurableBoundary,
} from "../../packages/core/src/ledger/transaction.js";

/**
 * Shared fault injection harness. Faults attach to named durable boundaries
 * of the ledger commit protocol; each kind models a failure class from the
 * test strategy: abrupt process death, hangs surfaced as timeouts, corrupt
 * output bytes, and external results whose outcome is unknown to the caller.
 */
export type FaultKind = "process-kill" | "timeout" | "corrupt-output" | "uncertain-result";

export interface FaultSpec {
  readonly boundary: DurableBoundary;
  readonly kind: FaultKind;
}

export class SimulatedProcessKill extends Error {
  readonly boundary: DurableBoundary;

  constructor(boundary: DurableBoundary) {
    super(`simulated process kill at durable boundary: ${boundary}`);
    this.name = "SimulatedProcessKill";
    this.boundary = boundary;
  }
}

export class SimulatedTimeout extends Error {
  readonly boundary: DurableBoundary;

  constructor(boundary: DurableBoundary) {
    super(`simulated timeout at durable boundary: ${boundary}`);
    this.name = "SimulatedTimeout";
    this.boundary = boundary;
  }
}

/** The operation may have completed durably, but the caller cannot tell. */
export class UncertainCommitResult extends Error {
  readonly boundary: DurableBoundary;

  constructor(boundary: DurableBoundary) {
    super(`uncertain commit result at durable boundary: ${boundary}`);
    this.name = "UncertainCommitResult";
    this.boundary = boundary;
  }
}

export interface FaultInjector {
  readonly hooks: CommitHooks;
  fired(): boolean;
}

/** Flip the first byte of a file so any digest or parse check trips. */
export function corruptFile(path: string): void {
  const content = readFileSync(path, "utf8");
  const first = content.length > 0 ? content[0] : "";
  const replacement = first === "{" ? "[" : "{";
  writeFileSync(path, `${replacement}${content.slice(1)}`, "utf8");
}

function corruptBoundaryOutput(context: BoundaryContext): void {
  const candidates = [...context.targetFiles, ...context.stagedFiles];
  const target = candidates[0];
  if (target === undefined) {
    throw new Error(`fault injector: nothing to corrupt at boundary for ${context.operationId}`);
  }
  corruptFile(target);
}

/**
 * Create commit hooks that inject exactly one fault the first time the named
 * durable boundary is crossed. Kills, timeouts and uncertain results throw
 * out of the commit; corrupt output mutates bytes and lets the commit
 * continue so integrity checks can prove they catch it.
 */
export function createFaultInjector(spec: FaultSpec): FaultInjector {
  let fired = false;
  return {
    fired: () => fired,
    hooks: {
      atBoundary(boundary: DurableBoundary, context: BoundaryContext) {
        if (fired || boundary !== spec.boundary) return;
        fired = true;
        switch (spec.kind) {
          case "process-kill":
            throw new SimulatedProcessKill(boundary);
          case "timeout":
            throw new SimulatedTimeout(boundary);
          case "uncertain-result":
            throw new UncertainCommitResult(boundary);
          case "corrupt-output":
            corruptBoundaryOutput(context);
            return;
        }
      },
    },
  };
}
