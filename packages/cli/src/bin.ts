#!/usr/bin/env node
import { createProcessIo } from "./io.js";
import { runCli } from "./router.js";

/**
 * `harness` binary entry. All behavior lives in `runCli`; this wrapper only
 * wires process I/O and propagates the returned exit code, so the CLI stays
 * fully testable in-process.
 */
const exitCode = await runCli(process.argv.slice(2), {
  io: createProcessIo(),
  cwd: process.cwd(),
});
process.exitCode = exitCode;
