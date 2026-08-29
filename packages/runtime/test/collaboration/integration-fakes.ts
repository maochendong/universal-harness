import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  canonicalizeJson,
  contentDigest,
  sha256Hex,
  validateSchema,
  verifyManifestDigest,
  verifyRecordEnvelope,
  type CollaborationConnectionRecord,
  type ControlRecord,
  type IntegrationRecord,
  type LedgerOperation,
} from "@universal-harness-internal/core";

import { collaborationFailure, type CollaborationFailure } from "../../src/collaboration/errors.js";
import type {
  AppendControlInput,
  AppendProjectRecordInput,
  GitControlStorePort,
  PrepareGitCandidateInput,
  PreparedGitCandidateResult,
  ReadIntegrationRecordInput,
  TargetCasInput,
} from "../../src/collaboration/port.js";

/**
 * In-memory git-ish GitControlStorePort for the integration coordinator tests.
 * Commits carry a full tree snapshot (paths -> content); refs name commit
 * oids; the Control Ref chain and project connection records mirror the
 * simpler coordinator fakes. `prepareCandidate` performs a real three-way
 * merge over the snapshot trees so conflict, resequencing and replay behavior
 * match the production adapter's contract, and the candidate tree is
 * materialized into a temporary directory so the coordinator's tree-based
 * validation (ledger replay, graph materialization) runs against real bytes.
 */

export const TARGET_REF = "refs/heads/main";
export const operationRefFor = (operationId: string): string =>
  `refs/heads/operation/${operationId}`;
export const candidateStagingRefFor = (integrationId: string): string =>
  `refs/heads/harness/candidate/${integrationId}`;

interface FakeCommit {
  readonly parents: readonly string[];
  readonly tree: ReadonlyMap<string, string>;
}

export interface IntegrationFakeStore {
  readonly port: GitControlStorePort;
  readonly controlRecords: ControlRecord[];
  readonly projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[];
  /** Scratch root the last prepareCandidate returned; invalidated by the next. */
  lastCandidateRoot?: string;
  /** When true, the next target CAS swaps the ref and then reports a lost response. */
  loseNextCasResponse: boolean;
  /** Commit `changes` (undefined deletes) on top of `parents`; returns the oid. */
  commitTree(
    parents: readonly string[],
    changes: Readonly<Record<string, string | undefined>>,
  ): string;
  tip(ref: string): string | undefined;
  moveRef(ref: string, oid: string): void;
  /** Replace the record file inside the staged candidate (tampering fixture). */
  replaceStagingRecord(integrationId: string, record: IntegrationRecord): void;
}

function failure(
  code: CollaborationFailure["code"],
  summary: string,
  retryable = false,
): CollaborationFailure {
  return collaborationFailure(code, summary, retryable);
}

export function createIntegrationFakeStore(): IntegrationFakeStore {
  const commits = new Map<string, FakeCommit>();
  const refs = new Map<string, string>();
  const controlRecords: ControlRecord[] = [];
  const projectRecords: (CollaborationConnectionRecord | IntegrationRecord)[] = [];
  let counter = 0;
  const store: IntegrationFakeStore = {
    controlRecords,
    projectRecords,
    loseNextCasResponse: false,
    commitTree(parents, changes) {
      const base = parents.length === 0 ? new Map<string, string>() : treeOf(parents[0] as string);
      const tree = new Map(base);
      for (const [path, content] of Object.entries(changes)) {
        if (content === undefined) tree.delete(path);
        else tree.set(path, content);
      }
      counter += 1;
      const oid = counter.toString(16).padStart(40, "0");
      commits.set(oid, { parents: [...parents], tree });
      return oid;
    },
    tip(ref) {
      return refs.get(ref);
    },
    moveRef(ref, oid) {
      refs.set(ref, oid);
    },
    replaceStagingRecord(integrationId, record) {
      const staged = refs.get(candidateStagingRefFor(integrationId));
      if (staged === undefined) throw new Error(`no staged candidate for ${integrationId}`);
      const commit = commits.get(staged) as FakeCommit;
      const tree = new Map(commit.tree);
      tree.set(
        `.harness/artifacts/integrations/${integrationId}.json`,
        `${canonicalizeJson(record)}\n`,
      );
      counter += 1;
      const oid = counter.toString(16).padStart(40, "0");
      commits.set(oid, { parents: commit.parents, tree });
      refs.set(candidateStagingRefFor(integrationId), oid);
    },
    port: {
      readControl(input) {
        const head =
          controlRecords.length === 0 ? undefined : `oid_control_${controlRecords.length}`;
        const latest = [...projectRecords]
          .reverse()
          .find(
            (record): record is CollaborationConnectionRecord =>
              record.record_kind === "collaboration_connection",
          );
        const targetHead = input.target_ref === undefined ? undefined : refs.get(input.target_ref);
        return Promise.resolve({
          status: "ok" as const,
          snapshot: {
            ...(head === undefined ? {} : { control_head_oid: head }),
            control_records: [...controlRecords],
            ...(latest === undefined ? {} : { latest_connection: latest }),
            ...(targetHead === undefined ? {} : { target_head_oid: targetHead }),
          },
        });
      },
      appendControl(input: AppendControlInput) {
        const expected =
          controlRecords.length === 0 ? undefined : `oid_control_${controlRecords.length}`;
        if (input.expected_head_oid !== expected) {
          return Promise.resolve({
            status: "failed" as const,
            failure: failure("control_ref_cas_failed", "stale expected control head", true),
          });
        }
        controlRecords.push(input.record);
        return Promise.resolve({
          status: "appended" as const,
          head_oid: `oid_control_${controlRecords.length}`,
        });
      },
      appendProjectRecord(input: AppendProjectRecordInput) {
        projectRecords.push(input.record);
        return Promise.resolve({
          status: "committed" as const,
          commit: String(projectRecords.length).padStart(16, "0"),
        });
      },
      listOperationHeads() {
        const heads: { operation_id: string; head_oid: string }[] = [];
        for (const [ref, oid] of refs) {
          if (ref.startsWith("refs/heads/operation/")) {
            heads.push({ operation_id: ref.slice("refs/heads/operation/".length), head_oid: oid });
          }
        }
        return Promise.resolve({ status: "ok" as const, heads });
      },
      compareAndSwapOperation() {
        return Promise.resolve({
          status: "failed" as const,
          failure: failure("coordinator_unavailable", "not used in the integration tests"),
        });
      },
      prepareCandidate(input: PrepareGitCandidateInput) {
        return Promise.resolve(prepareCandidate(input));
      },
      readCandidate(input) {
        const staged = refs.get(candidateStagingRefFor(input.integration_id));
        if (staged === undefined) return Promise.resolve({ status: "missing" as const });
        const record = recordInCommit(staged, input.integration_id);
        if (record === undefined) {
          return Promise.resolve({
            status: "failed" as const,
            failure: failure(
              "ledger_resequence_failed",
              "staged candidate carries no readable integration record",
            ),
          });
        }
        return Promise.resolve({
          status: "found" as const,
          candidate_commit: staged,
          tree_oid: treeOidOf(staged),
          record,
        });
      },
      readIntegrationRecord(input: ReadIntegrationRecordInput) {
        const head = refs.get(input.target_ref);
        if (head === undefined) {
          return Promise.resolve({
            status: "failed" as const,
            failure: failure("git_remote_unavailable", `unknown target ref ${input.target_ref}`),
          });
        }
        const record = recordInCommit(head, input.integration_id);
        if (record === undefined) return Promise.resolve({ status: "missing" as const });
        return Promise.resolve({ status: "found" as const, commit: head, record });
      },
      compareAndSwapTarget(input: TargetCasInput) {
        const head = refs.get(input.target_ref);
        if (head !== input.expected_commit) {
          return Promise.resolve({
            status: "failed" as const,
            failure: failure(
              "target_cas_failed",
              "target head moved since the command froze it; re-read the target",
              true,
            ),
          });
        }
        if (!commits.has(input.new_commit)) {
          return Promise.resolve({
            status: "failed" as const,
            failure: failure("coordinator_unavailable", "candidate commit is not available"),
          });
        }
        if (!isAncestor(input.expected_commit, input.new_commit)) {
          return Promise.resolve({
            status: "failed" as const,
            failure: failure(
              "target_cas_failed",
              "candidate commit does not descend from the expected target commit",
            ),
          });
        }
        refs.set(input.target_ref, input.new_commit);
        if (store.loseNextCasResponse) {
          store.loseNextCasResponse = false;
          return Promise.resolve({
            status: "failed" as const,
            failure: failure(
              "git_remote_unavailable",
              "the target compare-and-swap response was lost",
              true,
            ),
          });
        }
        return Promise.resolve({ status: "swapped" as const, commit: input.new_commit });
      },
    },
  };

  function treeOf(oid: string): ReadonlyMap<string, string> {
    const commit = commits.get(oid);
    if (commit === undefined) throw new Error(`unknown commit ${oid}`);
    return commit.tree;
  }

  function treeOidOf(oid: string): string {
    return contentDigest([...treeOf(oid).entries()].sort());
  }

  function ancestorsOf(oid: string): Set<string> {
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = commits.get(current);
      if (commit !== undefined) queue.push(...commit.parents);
    }
    return seen;
  }

  function isAncestor(ancestor: string, descendant: string): boolean {
    return ancestorsOf(descendant).has(ancestor);
  }

  function mergeBaseOf(left: string, right: string): string | undefined {
    const leftAncestors = ancestorsOf(left);
    const queue = [right];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (leftAncestors.has(current)) return current;
      const commit = commits.get(current);
      if (commit !== undefined) queue.push(...commit.parents);
    }
    return undefined;
  }

  /** Manifests committed in one tree, path order; bad bytes fail closed. */
  function manifestsIn(
    commit: string,
  ): { readonly manifests: LedgerOperation[] } | { readonly failure: CollaborationFailure } {
    const manifests: LedgerOperation[] = [];
    for (const [path, content] of [...treeOf(commit).entries()].sort()) {
      if (!path.startsWith(".harness/ledger/operations/") || !path.endsWith(".json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { failure: failure("ledger_resequence_failed", `unparsable manifest at ${path}`) };
      }
      if (!validateSchema("ledger-operation", parsed).valid) {
        return {
          failure: failure("ledger_resequence_failed", `invalid manifest at ${path}`),
        };
      }
      const manifest = parsed as LedgerOperation;
      if (!verifyManifestDigest(manifest)) {
        return {
          failure: failure("ledger_resequence_failed", `manifest digest mismatch at ${path}`),
        };
      }
      manifests.push(manifest);
    }
    return { manifests };
  }

  function recordInCommit(commit: string, integrationId: string): IntegrationRecord | undefined {
    const content = treeOf(commit).get(`.harness/artifacts/integrations/${integrationId}.json`);
    if (content === undefined) return undefined;
    try {
      const parsed = JSON.parse(content) as IntegrationRecord;
      if (
        parsed.record_kind !== "integration" ||
        parsed.integration_id !== integrationId ||
        !verifyRecordEnvelope(parsed as unknown as Record<string, unknown>)
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  function materializeCandidateRoot(tree: ReadonlyMap<string, string>): string {
    if (store.lastCandidateRoot !== undefined) {
      rmSync(store.lastCandidateRoot, { recursive: true, force: true });
    }
    const root = mkdtempSync(join(tmpdir(), "harness-candidate-"));
    for (const [path, content] of tree) {
      const absolute = join(root, ...path.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
    store.lastCandidateRoot = root;
    return root;
  }

  function prepareCandidate(input: PrepareGitCandidateInput): PreparedGitCandidateResult {
    if (!commits.has(input.expected_target_commit) || !commits.has(input.operation_commit)) {
      return {
        status: "failed",
        failure: failure("coordinator_unavailable", "frozen commit is not available"),
      };
    }
    if (refs.get(input.target_ref) !== input.expected_target_commit) {
      return {
        status: "failed",
        failure: failure(
          "baseline_drift",
          `target ref ${input.target_ref} no longer names the frozen commit`,
        ),
      };
    }
    if (refs.get(operationRefFor(input.operation_id)) !== input.operation_commit) {
      return {
        status: "failed",
        failure: failure(
          "operation_ref_drift",
          `operation branch ${input.operation_id} no longer names the frozen commit`,
          true,
        ),
      };
    }
    const base = mergeBaseOf(input.expected_target_commit, input.operation_commit);
    if (base === undefined) {
      return {
        status: "failed",
        failure: failure(
          "integration_conflict",
          "target and operation branch share no merge base; resolve the histories manually",
        ),
      };
    }
    if (isAncestor(input.operation_commit, input.expected_target_commit)) {
      return {
        status: "failed",
        failure: failure(
          "coordinator_unavailable",
          "operation branch is already contained in the target; there is nothing to integrate",
        ),
      };
    }

    // Three-way snapshot merge; a path changed on both sides conflicts.
    const baseTree = treeOf(base);
    const targetTree = treeOf(input.expected_target_commit);
    const operationTree = treeOf(input.operation_commit);
    const paths = new Set([...baseTree.keys(), ...targetTree.keys(), ...operationTree.keys()]);
    const mergedTree = new Map<string, string>();
    const conflicted: string[] = [];
    for (const path of [...paths].sort()) {
      const baseContent = baseTree.get(path);
      const targetContent = targetTree.get(path);
      const operationContent = operationTree.get(path);
      if (targetContent === operationContent) {
        if (targetContent !== undefined) mergedTree.set(path, targetContent);
      } else if (baseContent === targetContent) {
        if (operationContent !== undefined) mergedTree.set(path, operationContent);
      } else if (baseContent === operationContent) {
        if (targetContent !== undefined) mergedTree.set(path, targetContent);
      } else {
        conflicted.push(path);
      }
    }
    if (conflicted.length > 0) {
      return {
        status: "failed",
        failure: failure(
          "integration_conflict",
          `text conflict in: ${conflicted.join(", ")}; resolve it on the operation branch and re-prepare`,
        ),
      };
    }

    const targetOperations = manifestsIn(input.expected_target_commit);
    if ("failure" in targetOperations)
      return { status: "failed", failure: targetOperations.failure };
    const incomingOperations = manifestsIn(input.operation_commit);
    if ("failure" in incomingOperations) {
      return { status: "failed", failure: incomingOperations.failure };
    }
    const incomingDigests = new Set(
      incomingOperations.manifests.flatMap((manifest) => manifest.artifact_digests),
    );
    const incomingArtifacts = [...mergedTree.entries()]
      .filter(([path]) => path.startsWith(".harness/artifacts/"))
      .map(([path, content]) => ({ path, content, digest: sha256Hex(content) }))
      .filter((artifact) => incomingDigests.has(artifact.digest))
      .sort((left, right) => (left.path < right.path ? -1 : 1));

    const plan = input.plan({
      target_operations: targetOperations.manifests,
      incoming_operations: incomingOperations.manifests,
      incoming_artifacts: incomingArtifacts,
    });
    if (plan.status === "failed") return { status: "failed", failure: plan.failure };
    for (const write of plan.writes) {
      if (
        !/^\.harness\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(write.path) ||
        write.path.includes("//") ||
        write.path.split("/").some((segment) => segment === "." || segment === "..")
      ) {
        return {
          status: "failed",
          failure: failure(
            "ledger_resequence_failed",
            `candidate plan wrote an illegal path: ${JSON.stringify(write.path)}`,
          ),
        };
      }
    }
    const candidateTree = new Map(mergedTree);
    for (const write of plan.writes) {
      candidateTree.set(write.path, write.content);
    }
    counter += 1;
    const candidateCommit = counter.toString(16).padStart(40, "0");
    commits.set(candidateCommit, {
      parents: [input.expected_target_commit, input.operation_commit],
      tree: candidateTree,
    });
    refs.set(candidateStagingRefFor(plan.record.integration_id), candidateCommit);
    const candidateRoot = materializeCandidateRoot(candidateTree);
    return {
      status: "prepared",
      candidate_commit: candidateCommit,
      tree_oid: contentDigest([...candidateTree.entries()].sort()),
      integration_id: plan.record.integration_id,
      candidate_root: candidateRoot,
    };
  }

  return store;
}
