#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createProcessIo } from "./io.js";
import { runCli } from "./router.js";

/**
 * Load KEY=VALUE pairs from a local `.env` file (gitignored, e.g. the fixed
 * provider API key) without overriding variables already present in the
 * ambient environment. Kept dependency-free and limited to the binary entry
 * so in-process tests never see this side effect.
 */
function loadDotEnvFile(cwd: string): void {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    const name = match?.[1];
    const raw = match?.[2];
    if (name === undefined || raw === undefined || process.env[name] !== undefined) continue;
    process.env[name] = raw.replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
  }
}

loadDotEnvFile(process.cwd());

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
