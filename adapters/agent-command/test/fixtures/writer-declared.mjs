import { mkdirSync, writeFileSync } from "node:fs";

// Writes inside the declared write scope, then completes with usage.
mkdirSync("src", { recursive: true });
writeFileSync("src/greeting.txt", "hello\n");
process.stdout.write(
  JSON.stringify({
    status: "completed",
    summary: "wrote declared file",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }),
);
