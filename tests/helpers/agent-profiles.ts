import type {
  AgentControlProfile,
  AgentProviderManifest,
  AgentTaskEnvelope,
} from "../../packages/plugin-sdk/src/agent.js";

/**
 * Shared contract fixtures for AgentAdapter tests (design 13.2): one control
 * profile per control level plus the trajectory visibility ladder, reused by
 * the adapter unit tests and the delegated-provider security test so every
 * suite exercises the same declared capabilities.
 */

export const MANAGED_PROFILE: AgentControlProfile = {
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
};

/** Delegated provider whose manifest proves metering, interception and resume. */
export const DELEGATED_CAPABLE_PROFILE: AgentControlProfile = {
  control: "delegated",
  trajectory_visibility: "summarized",
  usage_metering: true,
  side_effect_interception: true,
};

/** Opaque delegated provider: no metering, no interception, no trajectory. */
export const DELEGATED_OPAQUE_PROFILE: AgentControlProfile = {
  control: "delegated",
  trajectory_visibility: "external-only",
  usage_metering: false,
  side_effect_interception: false,
};

export const MANUAL_PROFILE: AgentControlProfile = {
  control: "manual",
  trajectory_visibility: "external-only",
  usage_metering: false,
  side_effect_interception: false,
};

export const TRAJECTORY_VISIBILITY_LADDER = ["full", "summarized", "external-only"] as const;

export function manifestFromProfile(
  provider: string,
  profile: AgentControlProfile,
  resumeSemantics: AgentProviderManifest["resume_semantics"],
): AgentProviderManifest {
  return { provider, ...profile, resume_semantics: resumeSemantics };
}

/** A minimal envelope satisfying the structural port contract. */
export function fixtureEnvelope(overrides: Partial<AgentTaskEnvelope> = {}): AgentTaskEnvelope {
  return {
    task_id: "task-1",
    plan_id: "plan-1",
    iteration_id: "iteration-1",
    repository_id: "repo-1",
    objective: "Implement the greeting module",
    expected_output: "A greeting module with tests",
    acceptance_criteria: ["greeting module exists", "tests pass"],
    allowed_read_paths: ["src", "docs"],
    proposed_write_paths: ["src"],
    state_proposal_fields: ["summary", "open_questions"],
    baseline_commit: "0123456789abcdef0123456789abcdef01234567",
    input_digest: "a".repeat(64),
    digest: "b".repeat(64),
    loop_policy: { max_steps: 30, max_tokens: 120000, max_duration_ms: 2700000 },
    ...overrides,
  };
}
