import type { VcsAdapter } from "@universal-harness-internal/plugin-sdk";

const HARNESS_IDENTITY = { name: "Universal Harness", email: "harness@localhost" } as const;

export interface SnapshotLedgerFinalization {
  readonly ledger_commit: string | null;
  readonly repository_head: string;
}

/**
 * Commit artifacts written after the Snapshot transaction itself (DAG
 * checkpoint and optional advanced audit). This is the one finalization seam;
 * callers cannot claim a clean completed operation before it returns.
 */
export async function finalizeSnapshotLedger(input: {
  readonly project_root: string;
  readonly iteration_id: string;
  readonly vcs?: VcsAdapter;
  readonly read_baseline: () => string;
  readonly prior_ledger_commit: string | null;
}): Promise<SnapshotLedgerFinalization> {
  let ledgerCommit = input.prior_ledger_commit;
  if (input.vcs !== undefined) {
    const committed = await input.vcs.commit(input.project_root, {
      message: `harness: finalize capability dag ${input.iteration_id}`,
      paths: [".harness"],
      identity: HARNESS_IDENTITY,
    });
    if (committed.ok) ledgerCommit = committed.value;
  }
  return {
    ledger_commit: ledgerCommit,
    repository_head: input.read_baseline(),
  };
}
