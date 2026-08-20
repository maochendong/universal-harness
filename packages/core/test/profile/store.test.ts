import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProfileBindingError,
  compileCaptureModelProviderBindings,
  createCaptureModelProviderBindingRecord,
  createProjectProfileRecord,
} from "../../src/profile/records.js";
import { createProfileDecisionRecord } from "../../src/profile/decisions.js";
import {
  ProfileStoreError,
  appendProfileDecisionRecord,
  appendProjectProfileRecord,
  readCaptureModelProviderBindings,
  readLatestProjectProfile,
  readProjectProfileRevisions,
  submitCaptureModelProviderBindings,
} from "../../src/profile/store.js";
import type { ModelProviderBinding } from "../../src/schema/profile.js";
import {
  bindingContractFields,
  createCapturePromptContractRegistry,
  createTestPromptContractRegistry,
} from "../prompt/helpers.js";

function captureScopeBindings(
  configs: readonly {
    readonly purpose: "project_discovery" | "approval_brief";
    readonly prompt_version: string;
    readonly schema_version: string;
  }[],
) {
  return compileCaptureModelProviderBindings({
    prompt_contract_resolver: createCapturePromptContractRegistry(),
    configs: configs.map((config) => ({
      slot_id: "grounded_synthesis" as const,
      purpose: config.purpose,
      required: true,
      provider_identity: "provider_anthropic",
      config_digest: DIGEST_C,
      prompt_version: config.prompt_version,
      schema_version: config.schema_version,
      budget_profile: "capture-standard",
      failure_mode: "block" as const,
    })),
  });
}

/** A fully-formed binding for a non-capture slot (resolved from the PG-0 stub registry). */
function operationScopeBinding(): ModelProviderBinding {
  const contractFields = bindingContractFields(
    createTestPromptContractRegistry().resolve({
      port_id: "plan_proposal",
      prompt_version: "plan_proposal.v1",
    }),
  );
  return {
    slot_id: "plan_proposal",
    required: true,
    provider_identity: "provider_anthropic",
    config_digest: DIGEST_C,
    prompt_version: "plan_proposal.v1",
    schema_version: "plan-proposal-result.v1",
    budget_profile: "plan-standard",
    failure_mode: "block",
    ...contractFields,
  };
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const TIMESTAMP = "2026-08-19T00:00:00.000Z";
const PROJECT_ID = "project_demo-app";

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-profile-store-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function profileRecord(
  revision: number,
  profileId: "lite" | "standard" | "governed",
  supersedesDigest?: string,
) {
  return createProjectProfileRecord({
    project_id: PROJECT_ID,
    revision,
    profile_id: profileId,
    policy_digest: DIGEST_A,
    actor: "human:reviewer",
    effective_from: TIMESTAMP,
    ...(supersedesDigest === undefined ? {} : { supersedes_digest: supersedesDigest }),
  });
}

describe("project profile store", () => {
  it("appends revisions and resolves the latest one", () => {
    const root = makeRoot();
    expect(readLatestProjectProfile(root, PROJECT_ID)).toBeUndefined();

    const first = profileRecord(1, "lite");
    expect(appendProjectProfileRecord(root, first)).toEqual({ appended: true });
    // Re-appending the identical record is an idempotent no-op.
    expect(appendProjectProfileRecord(root, first)).toEqual({ appended: false });

    const second = profileRecord(2, "standard", first.record_digest);
    expect(appendProjectProfileRecord(root, second)).toEqual({ appended: true });

    expect(readLatestProjectProfile(root, PROJECT_ID)).toEqual(second);
    expect(readProjectProfileRevisions(root, PROJECT_ID).map((record) => record.revision)).toEqual([
      1, 2,
    ]);
    // The downgrade/upgrade history is append-only: revision 1 keeps its content.
    expect(readProjectProfileRevisions(root, PROJECT_ID)[0]).toEqual(first);
  });

  it("rejects revision gaps and conflicting rewrites", () => {
    const root = makeRoot();
    const first = profileRecord(1, "lite");
    appendProjectProfileRecord(root, first);
    expect(() => appendProjectProfileRecord(root, profileRecord(3, "standard"))).toThrow(
      ProfileStoreError,
    );
    expect(() =>
      appendProjectProfileRecord(
        root,
        createProjectProfileRecord({
          project_id: PROJECT_ID,
          revision: 1,
          profile_id: "governed",
          policy_digest: DIGEST_A,
          actor: "human:reviewer",
          effective_from: "2026-08-20T00:00:00.000Z",
        }),
      ),
    ).toThrow(ProfileStoreError);
  });

  it("never duplicates a decision for the same idempotency key", () => {
    const root = makeRoot();
    const decision = createProfileDecisionRecord({
      decision_kind: "project_profile_change",
      project_id: PROJECT_ID,
      actor: "human:reviewer",
      idempotency_key: "select-lite",
      current_profile_id: "lite",
      decided_profile_id: "lite",
      policy_digest: DIGEST_A,
      decided_at: TIMESTAMP,
    });
    expect(appendProfileDecisionRecord(root, decision)).toEqual({ appended: true });
    expect(appendProfileDecisionRecord(root, decision)).toEqual({ appended: false });

    const conflicting = createProfileDecisionRecord({
      decision_kind: "project_profile_change",
      project_id: PROJECT_ID,
      actor: "human:other",
      idempotency_key: "select-lite",
      current_profile_id: "lite",
      decided_profile_id: "standard",
      policy_digest: DIGEST_A,
      decided_at: "2026-08-20T00:00:00.000Z",
    });
    expect(conflicting.profile_decision_id).toBe(decision.profile_decision_id);
    expect(() => appendProfileDecisionRecord(root, conflicting)).toThrow(ProfileStoreError);
  });
});

describe("capture-scope model provider bindings", () => {
  function bindingRecord() {
    return createCaptureModelProviderBindingRecord({
      project_id: PROJECT_ID,
      profile_decision_id: "profile-decision_01K1ABCDEFGHIJKLMNO",
      profile_decision_digest: DIGEST_B,
      policy_digest: DIGEST_A,
      config_digest: DIGEST_C,
      baseline_digest: DIGEST_B,
      bindings: captureScopeBindings([
        {
          purpose: "project_discovery",
          prompt_version: "project-discovery.v1",
          schema_version: "project-discovery-result.v1",
        },
        {
          purpose: "approval_brief",
          prompt_version: "approval-brief.v1",
          schema_version: "approval-brief-result.v1",
        },
      ]),
    });
  }

  it("persists bindings that tie the decision, policy, config, baseline and versions", () => {
    const root = makeRoot();
    const record = bindingRecord();
    expect(submitCaptureModelProviderBindings(root, record)).toEqual({ appended: true });
    expect(submitCaptureModelProviderBindings(root, record)).toEqual({ appended: false });

    const [read] = readCaptureModelProviderBindings(root);
    expect(read).toEqual(record);
    expect(read.scope).toBe("capture");
    expect(read.profile_decision_digest).toBe(DIGEST_B);
    expect(read.bindings.map((binding) => binding.purpose)).toEqual([
      "approval_brief",
      "project_discovery",
    ]);
  });

  it("refuses bindings outside the capture scope", () => {
    expect(() =>
      createCaptureModelProviderBindingRecord({
        project_id: PROJECT_ID,
        profile_decision_id: "profile-decision_01K1ABCDEFGHIJKLMNO",
        profile_decision_digest: DIGEST_B,
        policy_digest: DIGEST_A,
        config_digest: DIGEST_C,
        baseline_digest: DIGEST_B,
        bindings: [operationScopeBinding()],
      }),
    ).toThrow(ProfileBindingError);
  });
});
