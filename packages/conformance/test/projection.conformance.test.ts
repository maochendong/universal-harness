import { describe, expect, it } from "vitest";

import { renderPrdProjection } from "@universal-harness-internal/adapter-projection-markdown";

import {
  assertConformance,
  fixtureProjectionGraph,
  fixtureProjectionGraphRevised,
  projectionConformanceCases,
  providerInstructionConformanceCases,
  runConformanceSuite,
} from "../src/index.js";

describe("adapter-projection-markdown conformance", () => {
  it("satisfies the shared projection provider contract", async () => {
    const report = await runConformanceSuite({
      plugin: "adapter-projection-markdown",
      kind: "projection",
      cases: projectionConformanceCases(
        renderPrdProjection,
        fixtureProjectionGraph(),
        fixtureProjectionGraphRevised(),
      ),
    });
    assertConformance(report);
  });
});

describe("provider instruction projection conformance", () => {
  it("reproduces one mirror digest and stays inside the managed root", async () => {
    const report = await runConformanceSuite({
      plugin: "runtime-provider-instruction",
      kind: "projection",
      cases: providerInstructionConformanceCases({
        provider: "example-provider",
        instruction: "# Pack instructions\n\nFollow the envelope.\n",
        task_envelope_digest: "a".repeat(64),
        context_bundle_digest: "b".repeat(64),
      }),
    });
    assertConformance(report);
    expect(report.total).toBeGreaterThan(0);
  });
});
