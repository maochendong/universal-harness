import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  assessUnattendedEligibility,
  checkProtocolCompatibility,
  isEvidenceDigest,
  pluginManifestDigest,
  validateAgentControlProfileClaim,
  validatePluginManifest,
  VCS_ERROR_KINDS,
  type AgentAdapter,
  type AgentTaskEnvelope,
  type ProjectionDocument,
  type ProjectionGraph,
  type VcsAdapter,
} from "@universal-harness-internal/plugin-sdk";
import {
  buildProviderInstructionMirror,
  managedProjectionPath,
  type ProviderInstructionSpec,
} from "@universal-harness-internal/runtime";

import { makeTempDir, removeTempDir } from "./fixtures.js";
import type { ConformanceCase } from "./runner.js";

/**
 * Contract assertions shared by every first-party plugin (plan Task 24 step
 * 4). Each builder returns named cases for the shared runner; a case fails by
 * throwing a plain Error with a human-readable message. The assertions encode
 * the contract, never a particular adapter's behavior: typed errors instead
 * of throws, declared-path confinement, deterministic digests and no
 * self-minted terminal success.
 */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const HEX_DIGEST = /^[a-f0-9]{64}$/u;

/** Capability manifest contract: valid, protocol-compatible, digest-stable. */
export function manifestConformanceCases(manifest: unknown): ConformanceCase[] {
  return [
    {
      name: "manifest validates against the plugin manifest schema",
      run() {
        const validated = validatePluginManifest(manifest);
        assert(validated.name.length > 0, "manifest must declare a name");
        assert(Array.isArray(validated.capabilities), "capabilities must be a list");
      },
    },
    {
      name: "manifest speaks a compatible protocol version",
      run() {
        const validated = validatePluginManifest(manifest);
        const compatibility = checkProtocolCompatibility(validated.protocol_version);
        assert(
          compatibility.compatible,
          `protocol ${validated.protocol_version} is not host-compatible`,
        );
      },
    },
    {
      name: "manifest digest is deterministic",
      run() {
        const validated = validatePluginManifest(manifest);
        const first = pluginManifestDigest(validated);
        const second = pluginManifestDigest(validatePluginManifest(manifest));
        assert(HEX_DIGEST.test(first), "manifest digest must be a SHA-256 hex digest");
        assertEqual(second, first, "manifest digest must not depend on validation order");
      },
    },
  ];
}

/**
 * Agent adapter contract (design 13.2): structured results, claims instead of
 * terminal success, filtered proposals, digest-bound evidence and supervised
 * fallback for unproven control profiles.
 */
export function agentAdapterConformanceCases(
  adapter: AgentAdapter,
  envelope: AgentTaskEnvelope,
): ConformanceCase[] {
  return [
    {
      name: "declares a valid control profile claim",
      run() {
        validateAgentControlProfileClaim(adapter.manifest);
      },
    },
    {
      name: "never mints a terminal success",
      async run() {
        const result = await adapter.run(envelope, { mode: "supervised" });
        assert(
          result.outcome !== "success",
          "an adapter outcome is a claim; only the Harness mints terminal success",
        );
      },
    },
    {
      name: "reports harness-measured usage with a metering declaration",
      async run() {
        const result = await adapter.run(envelope, { mode: "supervised" });
        assert(result.usage.duration_ms >= 0, "usage.duration_ms must be measured");
        assert(
          result.usage.metering === "provider_reported" || result.usage.metering === "unmetered",
          "usage.metering must declare whether the provider reported tokens",
        );
      },
    },
    {
      name: "filters state proposals to the envelope's declared fields",
      async run() {
        const result = await adapter.run(envelope, { mode: "supervised" });
        const declared = new Set(envelope.state_proposal_fields);
        for (const key of Object.keys(result.state_proposal ?? {})) {
          assert(declared.has(key), `state proposal leaked undeclared field "${key}"`);
        }
      },
    },
    {
      name: "binds every evidence locator with a SHA-256 digest",
      async run() {
        const result = await adapter.run(envelope, { mode: "supervised" });
        for (const entry of result.evidence) {
          assert(
            isEvidenceDigest(entry.digest),
            `evidence "${entry.kind}" must carry a SHA-256 hex digest`,
          );
        }
      },
    },
    {
      name: "enforces the unattended eligibility of its control profile",
      async run() {
        const assessment = assessUnattendedEligibility(adapter.manifest);
        const result = await adapter.run(envelope, { mode: "unattended" });
        if (!assessment.eligible) {
          assertEqual(
            result.outcome,
            "correct_block",
            "an ineligible adapter must block unattended execution",
          );
          assertEqual(
            result.termination_reason,
            "policy_denial",
            "an ineligible unattended run must end as a policy denial",
          );
          assert(!result.completion_claimed, "a blocked run must not claim completion");
        } else {
          assert(
            result.outcome !== "success",
            "even an eligible unattended run must not self-mint success",
          );
        }
      },
    },
  ];
}

/**
 * VCS adapter contract (design 13.7): typed results instead of throws and
 * strict confinement to declared paths, so user modifications are never
 * touched ambiguously.
 */
export function vcsAdapterConformanceCases(adapter: VcsAdapter): ConformanceCase[] {
  const identity = { name: "Conformance", email: "conformance@example.com" };
  return [
    {
      name: "reports a non-repository as a typed error, never a throw",
      async run() {
        const directory = makeTempDir("harness-conf-vcs-");
        try {
          const result = await adapter.detectRepository(directory);
          assert(!result.ok, "detectRepository on a plain directory must fail");
          if (!result.ok) {
            assertEqual(
              result.error.kind,
              "not_a_repository",
              "the typed error must name the condition",
            );
          }
        } finally {
          removeTempDir(directory);
        }
      },
    },
    {
      name: "initializes a repository and reports a clean status",
      async run() {
        const directory = makeTempDir("harness-conf-vcs-");
        try {
          const initialized = await adapter.initRepository(directory, { initialBranch: "main" });
          assert(initialized.ok, "initRepository must succeed on an empty directory");
          if (initialized.ok) {
            const status = await adapter.status(initialized.value.root);
            assert(status.ok, "status must succeed inside the new repository");
            if (status.ok) {
              assert(status.value.clean, "a fresh repository must be clean");
              assertEqual(status.value.branch, "main", "the initial branch must be honored");
            }
          }
        } finally {
          removeTempDir(directory);
        }
      },
    },
    {
      name: "commits only the declared paths and leaves user files untouched",
      async run() {
        const directory = makeTempDir("harness-conf-vcs-");
        try {
          const initialized = await adapter.initRepository(directory, { initialBranch: "main" });
          assert(initialized.ok, "initRepository must succeed");
          if (!initialized.ok) return;
          const root = initialized.value.root;
          writeFileSync(join(root, "tracked.txt"), "harness-owned\n");
          writeFileSync(join(root, "stray.txt"), "user-owned\n");
          const committed = await adapter.commit(root, {
            message: "conformance commit",
            paths: ["tracked.txt"],
            identity,
          });
          assert(committed.ok, "commit of a declared path must succeed");
          const status = await adapter.status(root);
          assert(status.ok, "status must succeed after the commit");
          if (status.ok) {
            assert(
              status.value.untracked.includes("stray.txt"),
              "the undeclared user file must remain untracked and untouched",
            );
            assert(
              !status.value.staged.includes("stray.txt") &&
                !status.value.unstaged.includes("stray.txt"),
              "the undeclared user file must not be staged",
            );
          }
        } finally {
          removeTempDir(directory);
        }
      },
    },
    {
      name: "rejects an unknown ref as a typed error, never a throw",
      async run() {
        const directory = makeTempDir("harness-conf-vcs-");
        try {
          const initialized = await adapter.initRepository(directory, { initialBranch: "main" });
          assert(initialized.ok, "initRepository must succeed");
          if (!initialized.ok) return;
          const root = initialized.value.root;
          writeFileSync(join(root, "tracked.txt"), "harness-owned\n");
          await adapter.commit(root, { message: "seed", paths: ["tracked.txt"], identity });
          const diff = await adapter.diffSummary(root, "0".repeat(40));
          assert(!diff.ok, "diffing against an unknown ref must fail");
          if (!diff.ok) {
            assert(
              (VCS_ERROR_KINDS as readonly string[]).includes(diff.error.kind),
              `error kind "${diff.error.kind}" must be part of the VCS error contract`,
            );
          }
        } finally {
          removeTempDir(directory);
        }
      },
    },
  ];
}

/**
 * Projection provider contract (design 13.7): pure functions of graph state
 * with source revisions bound into the generation digest.
 */
export function projectionConformanceCases(
  render: (graph: ProjectionGraph) => ProjectionDocument,
  base: ProjectionGraph,
  revised: ProjectionGraph,
): ConformanceCase[] {
  return [
    {
      name: "regenerates byte-identical output from the same graph state",
      run() {
        const first = render(base);
        const second = render(base);
        assertEqual(second.markdown, first.markdown, "the rendered bytes must be reproducible");
        assertEqual(
          second.generation_digest,
          first.generation_digest,
          "the generation digest must be reproducible",
        );
      },
    },
    {
      name: "binds every source node with id and revision",
      run() {
        const document = render(base);
        assert(document.sources.length > 0, "a projection must name its sources");
        for (const source of document.sources) {
          assert(source.id.length > 0, "a source must carry a node id");
          assert(
            Number.isInteger(source.revision) && source.revision >= 1,
            `source ${source.id} must carry a positive integer revision`,
          );
        }
        assert(
          HEX_DIGEST.test(document.generation_digest),
          "the generation digest must be a SHA-256 hex digest",
        );
      },
    },
    {
      name: "changes the generation digest when a source revision changes",
      run() {
        const baseDocument = render(base);
        const revisedDocument = render(revised);
        assert(
          revisedDocument.generation_digest !== baseDocument.generation_digest,
          "a source revision change must invalidate the generation digest",
        );
      },
    },
  ];
}

/**
 * Provider Instruction Projection contract (design 13.7, plan Task 24 step
 * 4): the same Canonical Pack template, Task Envelope and ContextBundle
 * digests must reproduce the same mirror digest, and the mirror path is
 * confined to the managed projection root.
 */
export function providerInstructionConformanceCases(
  spec: ProviderInstructionSpec,
): ConformanceCase[] {
  return [
    {
      name: "reproduces the same mirror digest from the same inputs",
      run() {
        const first = buildProviderInstructionMirror(spec);
        const second = buildProviderInstructionMirror(spec);
        assertEqual(second.digest, first.digest, "the mirror digest must be reproducible");
        assertEqual(second.output.content, first.output.content, "the mirror bytes must match");
        assert(HEX_DIGEST.test(first.digest), "the mirror digest must be a SHA-256 hex digest");
      },
    },
    {
      name: "confines the mirror to the managed projection root",
      run() {
        const mirror = buildProviderInstructionMirror(spec);
        const managed = managedProjectionPath(mirror.output.name);
        assert(
          managed.startsWith("projections/"),
          "the mirror must live under the managed projection root",
        );
      },
    },
    {
      name: "rejects mirror paths escaping the managed root",
      run() {
        let rejected = false;
        try {
          managedProjectionPath("../escape.md");
        } catch {
          rejected = true;
        }
        assert(rejected, "a path escaping the managed root must be refused");
      },
    },
  ];
}
