import { describe, it } from "vitest";

import { createGitVcsAdapter } from "@universal-harness-internal/adapter-vcs-git";

import {
  assertConformance,
  runConformanceSuite,
  vcsAdapterConformanceCases,
} from "../src/index.js";

describe("adapter-vcs-git conformance", () => {
  it("satisfies the shared VCS adapter contract", async () => {
    const report = await runConformanceSuite({
      plugin: "adapter-vcs-git",
      kind: "vcs",
      cases: vcsAdapterConformanceCases(createGitVcsAdapter()),
    });
    assertConformance(report);
  });
});
