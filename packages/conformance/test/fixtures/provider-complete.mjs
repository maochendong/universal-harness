import { readFileSync } from "node:fs";

// Deterministic provider fixture for conformance: a completed run with
// usage, tool activity and a state proposal containing one undeclared field
// (which the adapter must drop and disclose).
const inputFile = process.argv[2];
const input = JSON.parse(readFileSync(inputFile, "utf8"));

const result = {
  status: "completed",
  summary: `provider completed task ${input.envelope.task_id}`,
  state_proposal: {
    summary: "implemented",
    conformance_note: "not declared",
  },
  evidence: [
    {
      kind: "artifact",
      locator: "artifacts/echo.txt",
      digest: "e".repeat(64),
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  tool_activity: { total_calls: 1, by_tool: { echo: 1 } },
};

process.stdout.write(JSON.stringify(result));
