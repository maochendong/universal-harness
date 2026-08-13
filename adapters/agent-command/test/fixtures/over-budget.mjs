// Completed status reporting usage far above any envelope token ceiling.
process.stdout.write(
  JSON.stringify({
    status: "completed",
    summary: "expensive run",
    usage: { input_tokens: 900000, output_tokens: 100000, total_tokens: 1000000 },
  }),
);
