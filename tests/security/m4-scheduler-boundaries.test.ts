import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { contentDigest } from "../../packages/core/src/index.js";
import { redactM4Evidence } from "../../scripts/dogfood-m4-redaction.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
// Assembled at runtime so the standalone scan does not mistake this synthetic
// machine path for a real one; redaction must still recognize the value.
const SYNTHETIC_USERS = ["", "Users"].join("/");

export const M4_SECURITY_BOUNDARIES = [
  {
    boundary: "path_traversal_and_reserved_authority_paths",
    evidence: [
      "tests/security/m4-path-and-lock-boundary.test.ts",
      "tests/security/path-traversal.test.ts",
    ],
  },
  {
    boundary: "symlink_escape",
    evidence: [
      "tests/security/m4-path-and-lock-boundary.test.ts",
      "tests/security/symlink-escape.test.ts",
    ],
  },
  {
    boundary: "command_argument_injection",
    evidence: ["tests/security/command-injection.test.ts"],
  },
  {
    boundary: "stale_approval",
    evidence: [
      "tests/fault/expired-approval.test.ts",
      "packages/runtime/test/scheduling/scheduler.test.ts",
    ],
  },
  {
    boundary: "adapter_privilege_expansion",
    evidence: [
      "tests/security/capability-escalation.test.ts",
      "tests/security/delegated-provider.test.ts",
      "tests/security/undeclared-write.test.ts",
    ],
  },
  {
    boundary: "output_sqlite_event_secret_scan",
    evidence: [
      "tests/security/secret-redaction.test.ts",
      "packages/runtime/test/scheduling/sqlite-projection.test.ts",
      "packages/runtime/test/scheduling/events.test.ts",
    ],
  },
  {
    boundary: "dashboard_force_action_rejection",
    evidence: [
      "packages/dashboard/test/security.test.ts",
      "packages/dashboard/test/scheduler-api.test.ts",
      "tests/e2e/dashboard-m4-scheduler.test.ts",
    ],
  },
] as const;

describe("M4 scheduler security release boundaries", () => {
  it("binds every approved boundary to tracked executable evidence", () => {
    expect(M4_SECURITY_BOUNDARIES.map((entry) => entry.boundary)).toEqual([
      "path_traversal_and_reserved_authority_paths",
      "symlink_escape",
      "command_argument_injection",
      "stale_approval",
      "adapter_privilege_expansion",
      "output_sqlite_event_secret_scan",
      "dashboard_force_action_rejection",
    ]);
    for (const entry of M4_SECURITY_BOUNDARIES) {
      expect(entry.evidence.length, entry.boundary).toBeGreaterThan(0);
      for (const path of entry.evidence) {
        const absolute = resolve(repositoryRoot, path);
        expect(existsSync(absolute), `${entry.boundary}: ${path}`).toBe(true);
        execFileSync("git", ["ls-files", "--error-unmatch", path], {
          cwd: repositoryRoot,
          stdio: "pipe",
        });
        const source = readFileSync(absolute, "utf8");
        expect(source, `${entry.boundary}: ${path}`).toMatch(/\b(it|test)\s*\(/u);
        expect(contentDigest(source)).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
  });

  it("redacts provider secrets and machine paths before dogfood Evidence is published", () => {
    const secret = "sk-provider-secret/a+b";
    const root = `${SYNTHETIC_USERS}/operator/private/m4-run`;
    const redacted = redactM4Evidence(
      JSON.stringify({
        token: secret,
        encoded: encodeURIComponent(secret),
        path: `${root}/trace.json`,
      }),
      { secrets: [secret], absolute_paths: [root] },
    );

    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(encodeURIComponent(secret));
    expect(redacted).not.toContain(root);
    expect(redacted).toContain("***redacted-secret***");
    expect(redacted).toContain("<redacted-path>/trace.json");
  });
});
