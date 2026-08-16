import { describe, expect, it } from "vitest";

import { JudgeResponseError, parseJudgeResponse } from "../src/index.js";

const bounds = { changed_paths: ["src/app.ts"], line_counts: { "src/app.ts": 12 } } as const;

describe("LLM judge response validation", () => {
  it("accepts a strict bounded result", () => {
    expect(
      parseJudgeResponse(
        JSON.stringify({
          verdict: "warn",
          confidence: 0.75,
          reasons: [
            { code: "missing-case", message: "Add an edge-case test", path: "src/app.ts", line: 9 },
          ],
        }),
        bounds,
      ),
    ).toEqual({
      verdict: "warn",
      confidence: 0.75,
      reasons: [
        { code: "missing-case", message: "Add an edge-case test", path: "src/app.ts", line: 9 },
      ],
    });
  });

  it.each([
    ["unknown field", { verdict: "pass", confidence: 1, reasons: [], extra: true }],
    [
      "invalid path",
      {
        verdict: "fail",
        confidence: 1,
        reasons: [{ code: "x", message: "x", path: "etc/passwd" }],
      },
    ],
    [
      "line overflow",
      {
        verdict: "fail",
        confidence: 1,
        reasons: [{ code: "x", message: "x", path: "src/app.ts", line: 13 }],
      },
    ],
    ["empty reason", { verdict: "fail", confidence: 1, reasons: [{ code: "", message: "" }] }],
  ])("rejects %s and never defaults to pass", (_name, response) => {
    expect(() => parseJudgeResponse(JSON.stringify(response), bounds)).toThrowError(
      JudgeResponseError,
    );
  });
});
