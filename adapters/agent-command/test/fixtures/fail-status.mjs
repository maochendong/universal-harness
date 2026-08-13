// Provider reports a failed status with a detail message.
process.stdout.write(
  JSON.stringify({ status: "failed", summary: "could not finish", message: "tests red" }),
);
