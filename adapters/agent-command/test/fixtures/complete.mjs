import { readFileSync } from "node:fs";

// Completed run: valid structured result with usage, tool activity and a
// state proposal containing one undeclared field (dropped by the adapter).
const inputFile = process.argv[2];
const input = JSON.parse(readFileSync(inputFile, "utf8"));

const result = {
  status: "completed",
  summary: `provider completed task ${input.envelope.task_id}`,
  state_proposal: {
    summary: "implemented",
    open_questions: [],
    budget_use: { tokens: 10 },
  },
  evidence: [
    {
      kind: "artifact",
      locator: "artifacts/greeting.txt",
      digest: "e".repeat(64),
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  tool_activity: { total_calls: 3, by_tool: { edit: 2, test: 1 } },
};

process.stdout.write(JSON.stringify(result));
