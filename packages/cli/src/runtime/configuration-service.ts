import { execFileSync } from "node:child_process";

import {
  DEFAULT_PROFILE_POLICY_DIGEST,
  appendProfileDecisionRecord,
  appendProjectProfileRecord,
  contentDigest,
  createProfileDecisionRecord,
  createProjectProfileRecord,
  readManagedManifest,
  type ProfileId,
  type ProjectProfileRecord,
} from "@universal-harness-internal/core";

export interface RuntimeConfigurationService {
  projectId(projectRoot: string): string;
  baselineDigest(projectRoot: string): string;
  persistInitialProfile(projectRoot: string, profileId: ProfileId): ProjectProfileRecord;
  changeProjectProfile(
    projectRoot: string,
    latest: ProjectProfileRecord,
    profileId: ProfileId,
  ): ProjectProfileRecord;
}

export function projectIdForProject(projectRoot: string): string {
  return `project_${readManagedManifest(projectRoot).name}`;
}

export function baselineDigestForProject(projectRoot: string): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return contentDigest({ repository_head: head });
  } catch {
    return contentDigest({ repository_head: "unborn" });
  }
}

/** Git/profile configuration assembly shared by new, adopt, iterate and resume. */
export function createRuntimeConfigurationService(input: {
  readonly actor: string;
  readonly clock: () => string;
}): RuntimeConfigurationService {
  const appendDecision = (
    projectRoot: string,
    profile: ProjectProfileRecord,
    current: ProfileId,
  ): void => {
    appendProfileDecisionRecord(
      projectRoot,
      createProfileDecisionRecord({
        decision_kind: "project_profile_change",
        project_id: profile.project_id,
        actor: input.actor,
        idempotency_key: `profile-${profile.revision === 1 ? "select" : "change"}:${profile.project_id}:revision:${String(profile.revision)}`,
        current_profile_id: current,
        decided_profile_id: profile.profile_id,
        policy_digest: profile.policy_digest,
        decided_at: input.clock(),
      }),
    );
  };
  return {
    projectId: projectIdForProject,
    baselineDigest: baselineDigestForProject,
    persistInitialProfile(projectRoot, profileId) {
      const record = createProjectProfileRecord({
        project_id: projectIdForProject(projectRoot),
        revision: 1,
        profile_id: profileId,
        policy_digest: DEFAULT_PROFILE_POLICY_DIGEST,
        actor: input.actor,
        effective_from: input.clock(),
      });
      appendProjectProfileRecord(projectRoot, record);
      appendDecision(projectRoot, record, profileId);
      return record;
    },
    changeProjectProfile(projectRoot, latest, profileId) {
      const record = createProjectProfileRecord({
        project_id: latest.project_id,
        revision: latest.revision + 1,
        profile_id: profileId,
        policy_digest: latest.policy_digest,
        actor: input.actor,
        effective_from: input.clock(),
        supersedes_digest: latest.record_digest,
      });
      appendProjectProfileRecord(projectRoot, record);
      appendDecision(projectRoot, record, latest.profile_id);
      return record;
    },
  };
}
