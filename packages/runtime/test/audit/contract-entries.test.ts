import { describe, expect, it } from "vitest";

import { extractApiEntries } from "../../src/audit/contract-entries.js";

describe("extractApiEntries", () => {
  it("extracts endpoints and headings from a contract-named document", () => {
    const entries = extractApiEntries(
      "docs/api-contract.md",
      [
        "# API Contract",
        "",
        "## Sessions",
        "",
        "- POST /sessions -- create a session",
        "- GET /sessions/{id} -- read one",
      ].join("\n"),
    );
    expect(entries).toEqual(["API Contract", "GET /sessions/{id}", "POST /sessions", "Sessions"]);
  });

  it("ignores documents whose path does not name a contract", () => {
    expect(extractApiEntries("docs/design.md", "# Design\n\n- POST /sessions\n")).toBeUndefined();
    expect(extractApiEntries("README.md", "# Readme\n")).toBeUndefined();
  });

  it("returns undefined when no entries are present", () => {
    expect(
      extractApiEntries("docs/api-contract.md", "no headings, no endpoints\n"),
    ).toBeUndefined();
  });

  it("is deterministic and de-duplicated", () => {
    const content = "# Title\n\n- GET /a\n- GET /a\n";
    const first = extractApiEntries("docs/openapi.md", content);
    const second = extractApiEntries("docs/openapi.md", content);
    expect(first).toEqual(second);
    expect(first).toEqual(["GET /a", "Title"]);
  });
});
