import { writeFileSync } from "node:fs";

// Claims completion while writing outside the declared write scope.
writeFileSync("secrets.txt", "should not be here\n");
process.stdout.write(
  JSON.stringify({
    status: "completed",
    summary: "claims done",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }),
);
