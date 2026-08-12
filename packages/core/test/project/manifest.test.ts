import { describe, expect, it } from "vitest";

import {
  PROJECT_MANIFEST_VERSION,
  ProjectManifestError,
  createProjectManifest,
  parseProjectManifest,
  serializeProjectManifest,
} from "../../src/project/manifest.js";

const fixedNow = () => "2026-08-12T00:00:00.000Z";

describe("project manifest", () => {
  it("serializes deterministically and round-trips", () => {
    const manifest = createProjectManifest({
      name: "demo-project",
      repositoryId: "repo.demo",
      now: fixedNow,
    });
    expect(manifest.manifest_version).toBe(PROJECT_MANIFEST_VERSION);
    const serialized = serializeProjectManifest(manifest);
    expect(serialized).toBe(
      '{"created_at":"2026-08-12T00:00:00.000Z","manifest_version":1,"name":"demo-project","repository_id":"repo.demo"}\n',
    );
    expect(parseProjectManifest(serialized)).toEqual(manifest);
  });

  it("rejects invalid names, repository ids and timestamps", () => {
    for (const name of ["Demo", "-demo", "demo_project", ""]) {
      expect(() =>
        createProjectManifest({ name, repositoryId: "repo.demo", now: fixedNow }),
      ).toThrow(ProjectManifestError);
    }
    expect(() =>
      createProjectManifest({ name: "demo", repositoryId: "repo/demo", now: fixedNow }),
    ).toThrow(ProjectManifestError);
    expect(() =>
      createProjectManifest({ name: "demo", repositoryId: "repo.demo", now: () => "not-a-time" }),
    ).toThrow(ProjectManifestError);
  });

  it("rejects malformed or unsupported manifest content", () => {
    expect(() => parseProjectManifest("not json")).toThrow(ProjectManifestError);
    expect(() => parseProjectManifest("[]")).toThrow(ProjectManifestError);
    expect(() => parseProjectManifest('{"manifest_version":2,"name":"demo"}')).toThrow(
      ProjectManifestError,
    );
    expect(() =>
      parseProjectManifest(
        '{"created_at":"2026-08-12T00:00:00.000Z","manifest_version":1,"name":"Demo","repository_id":"repo.demo"}',
      ),
    ).toThrow(ProjectManifestError);
    expect(() => parseProjectManifest('{"manifest_version":1,"name":"demo"}')).toThrow(
      ProjectManifestError,
    );
  });
});
