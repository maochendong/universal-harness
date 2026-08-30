import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { redactSecrets } from "../../scripts/dogfood-m3-redaction.mjs";

/**
 * M3 dogfood redaction gate (plan M3 Task 9 review fix): the dogfood driver
 * shells out to git with a credential-bearing transport URL, so a failed
 * `execFileSync` message carries the PAT on the command line. These tests
 * prove the redactor strips the token and the transport URL from arbitrary
 * text, and — end to end — that a real failed run's evidence bundle never
 * contains the token bytes.
 */

const MARKER_TOKEN = "m3-redaction-marker-token-9f8e7d6c5b";
const MARKER_TRANSPORT = `https://x-access-token:${MARKER_TOKEN}@127.0.0.1:1/acme/demo.git`;

const created: string[] = [];
function makeTempDir(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-m3-redaction-")));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});

describe("redactSecrets", () => {
  it("strips the token and the credential-bearing transport URL from a git failure message", () => {
    // Shape of a real execFileSync failure: the full command line is embedded.
    const raw =
      `Command failed: git -c core.autocrlf=false -c gc.auto=0 clone ${MARKER_TRANSPORT} ` +
      `/tmp/work\nfatal: unable to connect to ${MARKER_TRANSPORT}`;
    expect(raw).toContain(MARKER_TOKEN); // guard against a vacuous test

    const redacted = redactSecrets(raw, [MARKER_TOKEN, MARKER_TRANSPORT]);
    expect(redacted).not.toContain(MARKER_TOKEN);
    expect(redacted).not.toContain(MARKER_TRANSPORT);
    expect(redacted).toContain("***redacted***");
  });

  it("also strips the URL-encoded form of a secret", () => {
    const secret = "token with/slash+plus";
    const text = `Authorization failed for ${encodeURIComponent(secret)}`;
    const redacted = redactSecrets(text, [secret]);
    expect(redacted).not.toContain(encodeURIComponent(secret));
    expect(redacted).toContain("***redacted***");
  });

  it("ignores undefined and empty secrets", () => {
    expect(redactSecrets("nothing to hide", [undefined, "", null])).toBe("nothing to hide");
  });
});

describe("dogfood driver failure path", () => {
  it(
    "writes a failed bundle without the token when the run dies on the platform path",
    { timeout: 120_000 },
    () => {
      const out = join(makeTempDir(), "bundle.json");
      const result = spawnSync(
        process.execPath,
        ["scripts/dogfood-m3-platform.mjs", "--provider", "github", "--out", out],
        {
          encoding: "utf8",
          timeout: 90_000,
          env: {
            ...process.env,
            HARNESS_DOGFOOD_GITHUB_TOKEN: MARKER_TOKEN,
            HARNESS_DOGFOOD_GITHUB_REPO: "nonexistent-acme/nonexistent-repo",
            HARNESS_DOGFOOD_GITHUB_COORDINATOR_IDENTITY: "harness-coordinator",
            HARNESS_DOGFOOD_GITHUB_REMOTE_URL: MARKER_TRANSPORT,
          },
        },
      );
      // A bogus PAT cannot authenticate: the run must fail (or, if the
      // platform is unreachable, fail the same way) — never pass, never hang.
      expect(result.status).toBe(1);
      expect(existsSync(out)).toBe(true);
      const text = readFileSync(out, "utf8");
      const bundle = JSON.parse(text) as { status?: string };
      expect(bundle.status).toBe("failed");
      expect(text).not.toContain(MARKER_TOKEN);
      expect(text).not.toContain(MARKER_TRANSPORT);
      // The stdout/stderr log surface must not carry the token either.
      expect(result.stdout).not.toContain(MARKER_TOKEN);
      expect(result.stderr).not.toContain(MARKER_TOKEN);
    },
  );
});
