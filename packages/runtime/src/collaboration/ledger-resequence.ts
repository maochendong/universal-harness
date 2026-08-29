import {
  manifestDigest,
  verifyManifestDigest,
  type LedgerOperation,
} from "@universal-harness-internal/core";

/**
 * Deterministic candidate-only Ledger sequence re-sequencing (design §14.2).
 *
 * Two Operation Branches forked from the same Target may carry candidate
 * manifests at the same sequence; the fork can never enter the Target as-is
 * (`mergeCommittedOperations` stays strict for accepted histories). Prepare
 * resolves the fork inside the candidate merge tree only: incoming-only
 * manifests are sorted by old sequence then `ledger_operation_id`, renumbered
 * consecutively from the Target's maximum sequence + 1 and re-digested with
 * the existing `manifestDigest()`. Operation Branch bytes and accepted Target
 * history are never rewritten; Artifact/Edge/Event shard bytes and
 * LifecycleEvent sequences are untouched.
 *
 * Anything the function cannot explain deterministically — the same
 * `ledger_operation_id` with a different digest, a non-linear Target history,
 * a manifest whose recorded digest does not recompute — throws
 * `LedgerResequenceError`; the caller maps it to `ledger_resequence_failed`
 * and never degrades to a plain Git merge.
 */
export class LedgerResequenceError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`cannot deterministically resequence the candidate ledger: ${reason}`);
    this.name = "LedgerResequenceError";
    this.reason = reason;
  }
}

/** One manifest's sequence change inside the candidate merge tree. */
export interface LedgerSequenceRewrite {
  readonly ledger_operation_id: string;
  readonly old_sequence: number;
  readonly old_manifest_digest: string;
  readonly new_sequence: number;
  readonly new_manifest_digest: string;
}

export interface LedgerResequence {
  /**
   * Every incoming-only manifest in final candidate form (final sequence and
   * digest), ordered by the new sequence. Manifests whose sequence did not
   * change are returned byte-identical to the input.
   */
  readonly manifests: readonly LedgerOperation[];
  /** The audit trail of actual sequence changes (old != new only). */
  readonly rewrites: readonly LedgerSequenceRewrite[];
}

function assertInterpretable(manifest: LedgerOperation, side: string): void {
  if (!verifyManifestDigest(manifest)) {
    throw new LedgerResequenceError(
      `${side} manifest ${manifest.ledger_operation_id} has a digest that does not recompute`,
    );
  }
  if (manifest.edge_file_digest === undefined || manifest.event_file_digest === undefined) {
    throw new LedgerResequenceError(
      `${side} manifest ${manifest.ledger_operation_id} does not record its shard digests`,
    );
  }
}

function resequencedManifest(manifest: LedgerOperation, sequence: number): LedgerOperation {
  if (manifest.sequence === sequence) return manifest;
  const { required_reader_version, edge_file_digest, event_file_digest } = manifest;
  if (edge_file_digest === undefined || event_file_digest === undefined) {
    throw new LedgerResequenceError(
      `manifest ${manifest.ledger_operation_id} does not record its shard digests`,
    );
  }
  const digest = manifestDigest({
    ledger_operation_id: manifest.ledger_operation_id,
    workflow_operation_id: manifest.workflow_operation_id,
    attempt_id: manifest.attempt_id,
    baseline_commit: manifest.baseline_commit,
    sequence,
    artifact_digests: [...manifest.artifact_digests],
    edge_file: manifest.edge_file,
    event_file: manifest.event_file,
    edge_file_digest,
    event_file_digest,
    ...(required_reader_version === undefined ? {} : { required_reader_version }),
    committed_at: manifest.committed_at,
  });
  return { ...manifest, sequence, digest };
}

export function resequenceCandidateLedger(input: {
  readonly target: readonly LedgerOperation[];
  readonly incoming: readonly LedgerOperation[];
}): LedgerResequence {
  // The accepted Target history must be a single linear chain; anything else
  // cannot be explained deterministically.
  const targetById = new Map<string, LedgerOperation>();
  const targetSequences = new Set<number>();
  let targetMaximum = 0;
  for (const manifest of input.target) {
    assertInterpretable(manifest, "target");
    const existing = targetById.get(manifest.ledger_operation_id);
    if (existing !== undefined && existing.digest !== manifest.digest) {
      throw new LedgerResequenceError(
        `target history carries ${manifest.ledger_operation_id} with conflicting digests`,
      );
    }
    if (targetSequences.has(manifest.sequence)) {
      throw new LedgerResequenceError(
        `target history is not a single linear chain: sequence ${manifest.sequence} appears twice`,
      );
    }
    targetById.set(manifest.ledger_operation_id, manifest);
    targetSequences.add(manifest.sequence);
    targetMaximum = Math.max(targetMaximum, manifest.sequence);
  }

  // Identify incoming-only manifests; an id the Target already accepted must
  // carry the identical digest, and duplicates inside the incoming set must
  // not disagree either.
  const incomingOnly = new Map<string, LedgerOperation>();
  for (const manifest of input.incoming) {
    assertInterpretable(manifest, "incoming");
    const accepted = targetById.get(manifest.ledger_operation_id);
    if (accepted !== undefined) {
      if (accepted.digest !== manifest.digest) {
        throw new LedgerResequenceError(
          `ledger_operation_id ${manifest.ledger_operation_id} has conflicting digests across branches`,
        );
      }
      continue;
    }
    const duplicate = incomingOnly.get(manifest.ledger_operation_id);
    if (duplicate !== undefined) {
      if (duplicate.digest !== manifest.digest) {
        throw new LedgerResequenceError(
          `incoming branch carries ${manifest.ledger_operation_id} with conflicting digests`,
        );
      }
      continue;
    }
    incomingOnly.set(manifest.ledger_operation_id, manifest);
  }

  const sorted = [...incomingOnly.values()].sort((left, right) =>
    left.sequence === right.sequence
      ? left.ledger_operation_id < right.ledger_operation_id
        ? -1
        : 1
      : left.sequence - right.sequence,
  );

  const manifests: LedgerOperation[] = [];
  const rewrites: LedgerSequenceRewrite[] = [];
  sorted.forEach((manifest, index) => {
    const newSequence = targetMaximum + index + 1;
    const resequenced = resequencedManifest(manifest, newSequence);
    manifests.push(resequenced);
    if (resequenced.digest !== manifest.digest) {
      rewrites.push({
        ledger_operation_id: manifest.ledger_operation_id,
        old_sequence: manifest.sequence,
        old_manifest_digest: manifest.digest,
        new_sequence: newSequence,
        new_manifest_digest: resequenced.digest,
      });
    }
  });
  return { manifests, rewrites };
}
