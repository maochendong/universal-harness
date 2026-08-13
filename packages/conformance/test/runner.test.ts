import { describe, expect, it } from "vitest";

import {
  ConformanceError,
  assertConformance,
  runConformanceSuite,
  type ConformanceSuite,
} from "../src/index.js";

function fakeSuite(): ConformanceSuite {
  return {
    plugin: "fixture-plugin",
    kind: "tool",
    cases: [
      { name: "first passes", run: () => undefined },
      {
        name: "second fails",
        run: () => {
          throw new Error("contract violation");
        },
      },
      {
        name: "third fails asynchronously",
        run: () => Promise.reject(new Error("async violation")),
      },
      { name: "fourth still runs", run: () => undefined },
    ],
  };
}

describe("conformance runner", () => {
  it("runs every case in order and records each failure", async () => {
    const report = await runConformanceSuite(fakeSuite());

    expect(report.plugin).toBe("fixture-plugin");
    expect(report.kind).toBe("tool");
    expect(report.total).toBe(4);
    expect(report.failed).toBe(2);
    expect(report.passed).toBe(false);
    expect(report.results.map((result) => result.name)).toEqual([
      "first passes",
      "second fails",
      "third fails asynchronously",
      "fourth still runs",
    ]);
    expect(report.results.map((result) => result.passed)).toEqual([true, false, false, true]);
    expect(report.results[1]?.error).toBe("contract violation");
    expect(report.results[2]?.error).toBe("async violation");
  });

  it("assertConformance throws a typed error naming every failure", async () => {
    const report = await runConformanceSuite(fakeSuite());

    let thrown: unknown;
    try {
      assertConformance(report);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConformanceError);
    const message = (thrown as ConformanceError).message;
    expect(message).toContain("second fails");
    expect(message).toContain("third fails asynchronously");
    expect((thrown as ConformanceError).report).toBe(report);
  });

  it("assertConformance returns a passing report unchanged", async () => {
    const report = await runConformanceSuite({
      plugin: "fixture-plugin",
      kind: "tool",
      cases: [{ name: "passes", run: () => undefined }],
    });

    expect(report.passed).toBe(true);
    expect(assertConformance(report)).toBe(report);
  });
});
