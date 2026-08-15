import { describe, expect, it } from "vitest";

import { fixtureEnvelope } from "../../../tests/helpers/agent-profiles.js";
import { renderDshTask } from "../src/index.js";

describe("renderDshTask", () => {
  it("maps the governed task envelope to a deterministic headless task", () => {
    const task = renderDshTask(
      fixtureEnvelope({
        allowed_read_paths: ["docs", "src"],
        proposed_write_paths: ["src"],
      }),
    );

    expect(task).toBe(
      [
        "You are executing one task governed by Universal Harness.",
        "Task: task-1",
        "Objective: Implement the greeting module",
        "Expected output: A greeting module with tests",
        "Acceptance criteria:",
        "- greeting module exists",
        "- tests pass",
        "Allowed read paths:",
        "- docs",
        "- src",
        "Allowed write paths:",
        "- src",
        "Required gates:",
        "- none declared",
        "Constraints:",
        "- Work only inside the current repository.",
        "- Do not modify .git or .harness authority/ledger files.",
        "- Do not claim completion until the requested implementation and tests are present.",
        "- Return a concise final summary; Universal Harness will independently verify it.",
      ].join("\n"),
    );
  });
});
