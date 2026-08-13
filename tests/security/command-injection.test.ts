import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import {
  buildScrubbedEnvironment,
  runPluginSubprocess,
} from "../../packages/plugin-sdk/src/index.js";

/**
 * Command injection security invariants (design 14, 16; security test list).
 * Provider processes and VCS operations run as a fixed executable plus an
 * argument array with `shell: false`: payloads carrying shell metacharacters
 * arrive at the child literally, never at a shell; the environment is
 * scrubbed to an explicit allowlist so ambient secrets never leak into
 * plugin processes.
 */
const created: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function subprocessOptions(cwd: string) {
  return {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    timeout_ms: 10_000,
    max_output_bytes: 64_000,
  };
}

describe("subprocess argument safety", () => {
  it("passes shell metacharacters to the child literally, never to a shell", async () => {
    const cwd = makeTempDir("harness-injection-");
    const marker = join(cwd, "pwned.txt");
    const payload = `$(touch ${marker}); \`touch ${marker}\`; touch ${marker}`;
    const result = await runPluginSubprocess(process.execPath, {
      ...subprocessOptions(cwd),
      args: ["-p", "process.argv[1]", payload],
    });
    expect(result.exit_code).toBe(0);
    // The payload round-tripped as one literal argument...
    expect(result.stdout.trim()).toBe(payload);
    // ...and nothing executed it.
    expect(existsSync(marker)).toBe(false);
  });

  it("does not expand globs, redirects or command chains", async () => {
    const cwd = makeTempDir("harness-injection-");
    const payload = "* > /tmp/should-not-exist && echo injected";
    const result = await runPluginSubprocess(process.execPath, {
      ...subprocessOptions(cwd),
      args: ["-p", "process.argv[1]", payload],
    });
    expect(result.stdout.trim()).toBe(payload);
    expect(existsSync("/tmp/should-not-exist")).toBe(false);
  });
});

describe("subprocess environment scrubbing", () => {
  it("passes only allowlisted variables through", () => {
    const env = buildScrubbedEnvironment(["PATH"], {
      PATH: "/usr/bin",
      SECRET_TOKEN: "super-secret-value",
      AWS_SESSION_TOKEN: "another-secret",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(JSON.stringify(env)).not.toContain("super-secret-value");
  });

  it("keeps ambient secrets out of the child process environment", async () => {
    const cwd = makeTempDir("harness-injection-");
    const secret = "ambient-secret-never-leak";
    const original = process.env.HARNESS_TEST_SECRET;
    process.env.HARNESS_TEST_SECRET = secret;
    try {
      const result = await runPluginSubprocess(process.execPath, {
        ...subprocessOptions(cwd),
        args: ["-p", "process.env.HARNESS_TEST_SECRET ?? 'unset'"],
      });
      expect(result.stdout.trim()).toBe("unset");
    } finally {
      if (original === undefined) delete process.env.HARNESS_TEST_SECRET;
      else process.env.HARNESS_TEST_SECRET = original;
    }
  });
});

describe("git adapter injection resistance", () => {
  it("rejects a branch name carrying shell metacharacters", async () => {
    const root = makeTempDir("harness-injection-git-");
    const adapter = createGitVcsAdapter();
    const initialized = await adapter.initRepository(root, { initialBranch: "main" });
    expect(initialized.ok).toBe(true);
    const result = await adapter.createBranch(root, "pwn;$(touch injected)");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_argument");
    expect(existsSync(join(root, "injected"))).toBe(false);
  });

  it("stores a metacharacter commit message literally without executing it", async () => {
    const root = makeTempDir("harness-injection-git-");
    const adapter = createGitVcsAdapter();
    await adapter.initRepository(root, { initialBranch: "main" });
    writeFileSync(join(root, "file.txt"), "content");
    const message = "chore: $(touch pwned) `touch pwned`";
    const committed = await adapter.commit(root, {
      message,
      paths: ["file.txt"],
      identity: { name: "harness-test", email: "harness-test@example.test" },
    });
    expect(committed.ok).toBe(true);
    const status = await adapter.status(root);
    expect(status.ok).toBe(true);
    expect(existsSync(join(root, "pwned"))).toBe(false);
  });
});
