// Floods stdout; the output cap must truncate and kill.
const chunk = "x".repeat(64 * 1024);
for (let index = 0; index < 64; index += 1) {
  process.stdout.write(chunk);
}
