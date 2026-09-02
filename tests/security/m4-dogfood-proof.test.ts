import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureDshSessionBoundary,
  captureWorkspaceProofBoundary,
  collectPackageBuildProvenance,
  parseDshSessionEvidence,
  readDshInvocationEvidence,
  resolveDshExecutable,
  resolveDshSessionRoot,
  resolveExpectedDshVersion,
  verifyProbeWorkspace,
} from "../../scripts/m4-dogfood-proof.mjs";

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-m4-dogfood-proof-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "harness@example.invalid"], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4 real-provider dogfood proof", () => {
  it("derives actual provider, model and usage from the dsh session instead of requested env", () => {
    const session = [
      { type: "session", id: "session-test" },
      {
        type: "request/context",
        data: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      },
      {
        type: "assistant/message",
        seq: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            source: { provider: "deepseek-official", model: "deepseek-v4-flash" },
          },
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 50,
            reasoningTokens: 5,
          },
        },
      },
      {
        type: "assistant/message",
        seq: 2,
        data: {
          turn: 1,
          step: 2,
          message: {
            source: { provider: "deepseek-official", model: "deepseek-v4-flash" },
          },
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 80,
            reasoningTokens: 1,
          },
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    expect(
      parseDshSessionEvidence(session, {
        requestedProviderModel: "deepseek-v4-pro",
      }),
    ).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      identity_source: "dsh_session_request_context_and_assistant_source",
      requested_model: "deepseek-v4-pro",
      requested_model_matches_observed: false,
      usage: {
        metering: "dsh_session_observed",
        model_call_count: 2,
        input_tokens: 110,
        cache_read_input_tokens: 130,
        output_tokens: 24,
        reasoning_tokens: 6,
        total_tokens: 264,
      },
    });
  });

  it("rejects a dsh session whose request and assistant identities disagree", () => {
    const session = [
      JSON.stringify({
        type: "request/context",
        data: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      }),
      JSON.stringify({
        type: "assistant/message",
        seq: 1,
        data: {
          turn: 1,
          step: 1,
          message: { source: { provider: "other-provider", model: "other-model" } },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      }),
    ].join("\n");

    expect(() => parseDshSessionEvidence(session)).toThrow(/identity is inconsistent/u);
  });

  it("uses deduplicated assistant/chunk usage and only falls back to assistant/message", () => {
    const usage = { inputTokens: 7, cacheReadTokens: 11, outputTokens: 3, reasoningTokens: 2 };
    const session = [
      { type: "request/context", data: { provider: "p", model: "m" } },
      {
        type: "assistant/chunk",
        seq: 10,
        data: { turn: 1, step: 1, chunk: { type: "usage", usage } },
      },
      {
        type: "assistant/chunk",
        seq: 10,
        data: { turn: 1, step: 1, chunk: { type: "usage", usage } },
      },
      {
        type: "assistant/message",
        seq: 11,
        data: { turn: 1, step: 1, message: { source: { provider: "p", model: "m" } }, usage },
      },
      {
        type: "assistant/message",
        seq: 12,
        data: {
          turn: 1,
          step: 2,
          message: { source: { provider: "p", model: "m" } },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    expect(parseDshSessionEvidence(session).usage).toEqual({
      metering: "dsh_session_observed",
      model_call_count: 2,
      input_tokens: 8,
      cache_read_input_tokens: 11,
      output_tokens: 4,
      reasoning_tokens: 2,
      total_tokens: 23,
    });
  });

  it("observes only the dsh session created after the invocation boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-dsh-sessions-"));
    roots.push(root);
    const previousDirectory = join(root, "previous", "session-old");
    mkdirSync(previousDirectory, { recursive: true });
    writeFileSync(join(previousDirectory, "session.jsonl.zstd"), "old compressed bytes\n");
    const expectedCwd = "/tmp/dogfood-scratch";
    const boundary = captureDshSessionBoundary({ sessionRoot: root, expectedCwd });

    const currentDirectory = join(root, "--tmp-dogfood-scratch--", "session-current");
    mkdirSync(currentDirectory, { recursive: true });
    const session = [
      JSON.stringify({ type: "session", id: "session-current", cwd: expectedCwd }),
      JSON.stringify({
        type: "request/context",
        data: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      }),
      JSON.stringify({
        type: "assistant/message",
        seq: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            source: { provider: "deepseek-official", model: "deepseek-v4-flash" },
          },
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 20,
            reasoningTokens: 1,
          },
        },
      }),
    ].join("\n");
    writeFileSync(join(currentDirectory, "session.jsonl.zstd"), "new compressed bytes\n");

    expect(
      readDshInvocationEvidence({
        sessionRoot: root,
        beforeBoundary: boundary,
        expectedCwd,
        requestedProviderModel: "deepseek-v4-pro",
        decompressSession: () => `${session}\n`,
      }),
    ).toMatchObject({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      requested_model_matches_observed: false,
      session_observation_source: "dsh_local_zstd_session",
      raw_session_persisted_in_release_bundle: false,
      session_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      usage: {
        metering: "dsh_session_observed",
        model_call_count: 1,
        input_tokens: 10,
        cache_read_input_tokens: 20,
        output_tokens: 2,
        reasoning_tokens: 1,
        total_tokens: 32,
      },
    });
  });

  it("rejects modified pre-boundary sessions and sessions owned by another cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-dsh-session-owner-"));
    roots.push(root);
    const directory = join(root, "--tmp-dogfood-scratch--", "session-current");
    mkdirSync(directory, { recursive: true });
    const artifact = join(directory, "session.jsonl.zstd");
    writeFileSync(artifact, "before\n");
    const boundary = captureDshSessionBoundary({
      sessionRoot: root,
      expectedCwd: "/tmp/dogfood-scratch",
    });
    writeFileSync(artifact, "after with different size\n");
    expect(() =>
      readDshInvocationEvidence({
        sessionRoot: root,
        beforeBoundary: boundary,
        expectedCwd: "/tmp/dogfood-scratch",
        decompressSession: () => "",
      }),
    ).toThrow(/0 observable new session files/u);

    const other = join(root, "--tmp-other--", "session-other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "session.jsonl.zstd"), "new\n");
    expect(() =>
      readDshInvocationEvidence({
        sessionRoot: root,
        beforeBoundary: boundary,
        expectedCwd: "/tmp/dogfood-scratch",
        decompressSession: () =>
          [
            JSON.stringify({ type: "session", id: "session-other", cwd: "/tmp/other" }),
            JSON.stringify({ type: "request/context", data: { provider: "p", model: "m" } }),
            JSON.stringify({
              type: "assistant/chunk",
              seq: 1,
              data: {
                turn: 1,
                step: 1,
                chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
              },
            }),
          ].join("\n"),
      }),
    ).toThrow(/does not belong to the expected cwd/u);
  });

  it("uses a portable dsh command unless an explicit path is configured", () => {
    expect(resolveDshExecutable({})).toBe("dsh");
    expect(resolveDshExecutable({ environment: "/opt/harness/dsh" })).toBe("/opt/harness/dsh");
    expect(resolveDshExecutable({ argument: "./tools/dsh", environment: "/opt/harness/dsh" })).toBe(
      "./tools/dsh",
    );
  });

  it("resolves the dsh session store from DSH_HOME before HOME", () => {
    expect(resolveDshSessionRoot({ dshHome: "/opt/dsh-state", home: "/home/test" })).toBe(
      "/opt/dsh-state/sessions",
    );
    expect(resolveDshSessionRoot({ home: "/home/test" })).toBe("/home/test/.dsh/sessions");
  });

  it("requires the expected dsh version from an independent CLI binding", () => {
    expect(resolveExpectedDshVersion({ argument: "0.1.0-rc.6" })).toBe("0.1.0-rc.6");
    expect(resolveExpectedDshVersion({})).toBeUndefined();
  });

  it("requires the exact expected bytes and no path outside the probe output", () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), "baseline\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
    const boundary = captureWorkspaceProofBoundary({ repositoryRoot: root });
    mkdirSync(join(root, "src", "dogfood"), { recursive: true });
    const expected = "export const m4DogfoodProbe = 'real-dsh';\n";
    writeFileSync(join(root, "src", "dogfood", "probe.ts"), expected, "utf8");

    expect(
      verifyProbeWorkspace({
        repositoryRoot: root,
        expectedPath: "src/dogfood/probe.ts",
        expectedBytes: expected,
        baselineCommit: "HEAD",
        beforeBoundary: boundary,
        allowedRawTracePaths: [],
      }),
    ).toMatchObject({
      status: "passed",
      exact_bytes_match: true,
      only_allowed_path_changed: true,
      changed_paths: ["src/dogfood/probe.ts"],
    });

    writeFileSync(join(root, "unexpected.txt"), "not allowed\n", "utf8");
    expect(
      verifyProbeWorkspace({
        repositoryRoot: root,
        expectedPath: "src/dogfood/probe.ts",
        expectedBytes: expected,
        baselineCommit: "HEAD",
        beforeBoundary: boundary,
        allowedRawTracePaths: [],
      }),
    ).toMatchObject({ status: "failed", only_allowed_path_changed: false });

    rmSync(join(root, "unexpected.txt"));
    writeFileSync(join(root, "src", "dogfood", "probe.ts"), "export const wrong = true;\n");
    expect(
      verifyProbeWorkspace({
        repositoryRoot: root,
        expectedPath: "src/dogfood/probe.ts",
        expectedBytes: expected,
        baselineCommit: "HEAD",
        beforeBoundary: boundary,
        allowedRawTracePaths: [],
      }),
    ).toMatchObject({ status: "failed", exact_bytes_match: false });
  });

  it("rejects symlinks, non-regular outputs and realpath escapes", () => {
    const root = repository();
    writeFileSync(join(root, ".gitignore"), ".harness/\n", "utf8");
    execFileSync("git", ["add", ".gitignore"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
    const boundary = captureWorkspaceProofBoundary({ repositoryRoot: root });
    const outside = join(root, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, "expected\n", "utf8");
    roots.push(outside);
    mkdirSync(join(root, "src"), { recursive: true });
    symlinkSync(outside, join(root, "src", "probe.ts"));

    expect(
      verifyProbeWorkspace({
        repositoryRoot: root,
        baselineCommit: "HEAD",
        beforeBoundary: boundary,
        expectedPath: "src/probe.ts",
        expectedBytes: "expected\n",
        allowedRawTracePaths: [],
      }),
    ).toMatchObject({
      status: "failed",
      output_regular_file: false,
      output_realpath_contained: false,
    });

    rmSync(join(root, "src", "probe.ts"));
    mkdirSync(join(root, "src", "probe.ts"));
    expect(
      verifyProbeWorkspace({
        repositoryRoot: root,
        baselineCommit: "HEAD",
        beforeBoundary: boundary,
        expectedPath: "src/probe.ts",
        expectedBytes: "expected\n",
        allowedRawTracePaths: [],
      }),
    ).toMatchObject({ status: "failed", output_regular_file: false });
  });

  it("detects ignored and reserved writes while allowing one exact raw transcript", () => {
    const root = repository();
    writeFileSync(join(root, ".gitignore"), ".harness/\n*.ignored\n", "utf8");
    execFileSync("git", ["add", ".gitignore"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
    const boundary = captureWorkspaceProofBoundary({ repositoryRoot: root });
    const expected = "export const probe = true;\n";
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "probe.ts"), expected, "utf8");
    const transcript = ".harness/raw-traces/agent-dsh/transcript-task.json";
    mkdirSync(join(root, ".harness", "raw-traces", "agent-dsh"), { recursive: true });
    writeFileSync(join(root, transcript), "{}\n", "utf8");

    expect(
      verifyProbeWorkspace({
        repositoryRoot: root,
        baselineCommit: "HEAD",
        beforeBoundary: boundary,
        expectedPath: "src/probe.ts",
        expectedBytes: expected,
        allowedRawTracePaths: [transcript],
      }),
    ).toMatchObject({
      status: "passed",
      raw_trace_paths: [transcript],
      unauthorized_paths: [],
    });

    writeFileSync(join(root, "hidden.ignored"), "hidden\n", "utf8");
    writeFileSync(join(root, ".harness", "authority.json"), "{}\n", "utf8");
    writeFileSync(join(root, ".git", "agent-rogue"), "changed\n", "utf8");
    const failed = verifyProbeWorkspace({
      repositoryRoot: root,
      baselineCommit: "HEAD",
      beforeBoundary: boundary,
      expectedPath: "src/probe.ts",
      expectedBytes: expected,
      allowedRawTracePaths: [transcript],
    });
    expect(failed.status).toBe("failed");
    expect(failed.unauthorized_paths).toEqual(
      expect.arrayContaining([".git/agent-rogue", ".harness/authority.json", "hidden.ignored"]),
    );
  });

  it("binds the complete emitted trees and internal runtime dependency closure", () => {
    const root = repository();
    mkdirSync(join(root, "packages", "demo", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "demo", "dist"), { recursive: true });
    mkdirSync(join(root, "packages", "dependency", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "dependency", "dist"), { recursive: true });
    writeFileSync(
      join(root, "packages", "demo", "package.json"),
      '{"name":"demo","dependencies":{"dependency":"workspace:*"}}\n',
    );
    writeFileSync(join(root, "packages", "demo", "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "packages", "demo", "dist", "index.js"), "export const x = 1;\n");
    writeFileSync(join(root, "packages", "demo", "dist", "index.d.ts"), "export {};\n");
    writeFileSync(join(root, "packages", "dependency", "package.json"), '{"name":"dependency"}\n');
    writeFileSync(
      join(root, "packages", "dependency", "src", "index.ts"),
      "export const dependency = true;\n",
    );
    writeFileSync(
      join(root, "packages", "dependency", "dist", "index.js"),
      "export const dependency = true;\n",
    );
    writeFileSync(join(root, "package.json"), '{"private":true}\n');
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execFileSync("git", ["add", "package.json", "pnpm-lock.yaml", "packages"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "source"], { cwd: root });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    const proof = collectPackageBuildProvenance({
      repositoryRoot: root,
      buildRoot: root,
      implementationCommit: commit,
      packages: [{ name: "demo", path: "packages/demo" }],
    });

    expect(proof).toMatchObject({
      implementation_commit: commit,
      source_head_matches_implementation_commit: true,
      tracked_source_clean: true,
      runtime_dependency_closure: ["demo", "dependency"],
      lockfile_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      provenance_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      packages: expect.arrayContaining([
        expect.objectContaining({
          name: "demo",
          path: "packages/demo",
          source_tree_oid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
          package_json_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          emitted_tree_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          emitted_files: [
            { path: "index.d.ts", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
            { path: "index.js", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
          ],
        }),
        expect.objectContaining({
          name: "dependency",
          path: "packages/dependency",
          source_tree_oid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
          package_json_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          emitted_tree_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]),
    });
  });
});
