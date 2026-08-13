// Reports which environment variables survived the allowlist scrub.
const passed = process.env.HARNESS_TEST_PASS ?? "unset";
const dropped = process.env.HARNESS_TEST_DROP ?? "unset";
process.stdout.write(
  JSON.stringify({
    status: "completed",
    summary: `pass=${passed} drop=${dropped}`,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }),
);
