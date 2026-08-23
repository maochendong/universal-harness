import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";
import { readLatestProjectProfile } from "@universal-harness-internal/core";
import { createNewProject } from "@universal-harness-internal/runtime";
import { createRuntimeConfigurationService } from "../src/runtime/configuration-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI runtime configuration facade", () => {
  it("preserves profile lineage and baseline identity through one public seam", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "harness-runtime-facade-")));
    roots.push(parent);
    const created = await createNewProject(
      { parentDirectory: parent, name: "facade", intent: "characterize runtime facades" },
      {
        vcs: createGitVcsAdapter(),
        now: () => "2026-08-23T00:00:00.000Z",
        newId: (kind) => `${kind}_facade`,
      },
    );
    if (!created.ok) throw new Error(created.error.message);
    let tick = 0;
    const service = createRuntimeConfigurationService({
      actor: "human:facade-test",
      clock: () => `2026-08-23T00:00:0${String(tick++)}.000Z`,
    });
    const initial = service.persistInitialProfile(created.value.projectRoot, "lite");
    const changed = service.changeProjectProfile(created.value.projectRoot, initial, "standard");

    expect(service.projectId(created.value.projectRoot)).toBe(initial.project_id);
    expect(service.baselineDigest(created.value.projectRoot)).toMatch(/^[a-f0-9]{64}$/u);
    expect(changed).toMatchObject({
      revision: 2,
      profile_id: "standard",
      supersedes_digest: initial.record_digest,
    });
    expect(
      readLatestProjectProfile(created.value.projectRoot, initial.project_id)?.record_digest,
    ).toBe(changed.record_digest);
  });
});
