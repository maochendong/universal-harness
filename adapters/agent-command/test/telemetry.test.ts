import { describe, expect, it } from "vitest";

import { AgentError } from "@universal-harness-internal/plugin-sdk";

import { parseProviderResult } from "../src/telemetry.js";

const DIGEST = "f".repeat(64);

describe("parseProviderResult", () => {
  it("parses a complete result document", () => {
    const parsed = parseProviderResult(
      JSON.stringify({
        status: "completed",
        summary: "done",
        state_proposal: { summary: "implemented" },
        evidence: [{ kind: "artifact", locator: "a.txt", digest: DIGEST }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        tool_activity: { total_calls: 2, by_tool: { edit: 2 } },
      }),
    );
    expect(parsed.status).toBe("completed");
    expect(parsed.usage?.total_tokens).toBe(15);
    expect(parsed.tool_activity?.by_tool).toEqual({ edit: 2 });
    expect(parsed.evidence?.[0]?.digest).toBe(DIGEST);
  });

  it("rejects unparseable output as invalid_result, never a result", () => {
    expect(() => parseProviderResult("not json")).toThrowError(AgentError);
    expect(() => parseProviderResult("not json")).toThrowError(/not valid JSON/u);
  });

  it("rejects unknown statuses and missing summaries", () => {
    expect(() =>
      parseProviderResult(JSON.stringify({ status: "success", summary: "x" })),
    ).toThrowError(/status/u);
    expect(() => parseProviderResult(JSON.stringify({ status: "completed" }))).toThrowError(
      /summary/u,
    );
  });

  it("rejects wrongly typed usage and tool activity", () => {
    const base = { status: "completed", summary: "done" };
    expect(() =>
      parseProviderResult(JSON.stringify({ ...base, usage: { total_tokens: -1 } })),
    ).toThrowError(/total_tokens/u);
    expect(() =>
      parseProviderResult(JSON.stringify({ ...base, tool_activity: { total_calls: "many" } })),
    ).toThrowError(/total_calls/u);
  });

  it("rejects evidence without a content digest", () => {
    expect(() =>
      parseProviderResult(
        JSON.stringify({
          status: "completed",
          summary: "done",
          evidence: [{ kind: "artifact", locator: "a.txt", digest: "nope" }],
        }),
      ),
    ).toThrowError(/evidence entry/u);
  });
});
