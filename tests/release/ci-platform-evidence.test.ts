import { describe, expect, it } from "vitest";

// Plain-MJS release helper is intentionally dependency-free and executable
// directly by GitHub Actions.
import {
  buildCiPlatformEvidence,
  evaluateCiPlatformEvidence,
} from "../../scripts/write-ci-platform-evidence.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PLATFORMS = ["ubuntu-latest", "macos-latest", "windows-latest"] as const;

function evidence(platform: (typeof PLATFORMS)[number], exitStatus = 0, commit = COMMIT) {
  return buildCiPlatformEvidence({
    commit,
    workflow: "CI",
    platform,
    command: "pnpm verify",
    exit_status: exitStatus,
  });
}

describe("evaluateCiPlatformEvidence", () => {
  it("passes only a complete same-commit three-platform evidence set", () => {
    expect(
      evaluateCiPlatformEvidence({
        current_commit: COMMIT,
        required_platforms: PLATFORMS,
        artifacts: PLATFORMS.map((platform) => evidence(platform)),
      }),
    ).toMatchObject({ status: "passed" });
  });

  it("fails when one platform recorded a non-zero verify result", () => {
    expect(
      evaluateCiPlatformEvidence({
        current_commit: COMMIT,
        required_platforms: PLATFORMS,
        artifacts: [
          evidence("ubuntu-latest"),
          evidence("macos-latest", 1),
          evidence("windows-latest"),
        ],
      }),
    ).toMatchObject({ status: "failed", failed_platforms: ["macos-latest"] });
  });

  it("returns not_verified for a missing platform", () => {
    expect(
      evaluateCiPlatformEvidence({
        current_commit: COMMIT,
        required_platforms: PLATFORMS,
        artifacts: [evidence("ubuntu-latest"), evidence("macos-latest")],
      }),
    ).toMatchObject({ status: "not_verified", missing_platforms: ["windows-latest"] });
  });

  it("returns not_verified for commit drift or a forged artifact digest", () => {
    expect(
      evaluateCiPlatformEvidence({
        current_commit: COMMIT,
        required_platforms: PLATFORMS,
        artifacts: [
          evidence("ubuntu-latest"),
          evidence("macos-latest"),
          evidence("windows-latest", 0, "f".repeat(40)),
        ],
      }),
    ).toMatchObject({ status: "not_verified", drifted_platforms: ["windows-latest"] });

    expect(
      evaluateCiPlatformEvidence({
        current_commit: COMMIT,
        required_platforms: PLATFORMS,
        artifacts: [
          evidence("ubuntu-latest"),
          evidence("macos-latest"),
          { ...evidence("windows-latest"), artifact_digest: "0".repeat(64) },
        ],
      }),
    ).toMatchObject({ status: "not_verified", invalid_artifacts: 1 });
  });
});
