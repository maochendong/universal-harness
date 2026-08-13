/**
 * Deterministic command provider for the command-adapter example. The
 * Harness writes the Task Envelope to an input file and invokes this script
 * with a fixed executable plus an argument array (never a shell); the
 * provider answers with one JSON result document on stdout.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const inputFile = process.argv[2];
const input = JSON.parse(readFileSync(inputFile, "utf8"));

const result = {
  status: "completed",
  summary: `provider completed task ${input.envelope.task_id}`,
  evidence: [
    {
      kind: "artifact",
      locator: `artifacts/${input.envelope.task_id}.txt`,
      digest: createHash("sha256").update(input.envelope.task_id).digest("hex"),
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  tool_activity: { total_calls: 1, by_tool: { echo: 1 } },
};

process.stdout.write(JSON.stringify(result));
