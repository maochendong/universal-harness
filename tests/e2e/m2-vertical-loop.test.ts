import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createTrustedProviderRegistry } from "../../packages/core/src/index.js";
import { FileEventStream, readLatestSnapshot } from "../../packages/runtime/src/index.js";

import {
  approveAndResume,
  cleanupE2eRoots,
  git,
  makeHarness,
  makeTempDir,
  runJson,
  sequentialIds,
  type CliRun,
} from "./helpers.js";

interface FakeJudge {
  readonly server: Server;
  readonly endpoint: string;
  calls(): number;
}

async function fakeJudge(): Promise<FakeJudge> {
  let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    request.resume();
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "pass",
                confidence: 0.99,
                reasons: [{ code: "m2-loop", message: "review passed" }],
              }),
            },
          },
        ],
      }),
    );
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("missing port"));
      else resolve(address.port);
    });
  });
  return {
    server,
    endpoint: `http://127.0.0.1:${String(port)}/v1/chat/completions`,
    calls: () => calls,
  };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function complete(
  first: CliRun,
  session: { readonly cwd: string; readonly runtime: ReturnType<typeof makeHarness>["runtime"] },
): Promise<CliRun> {
  let result = first;
  for (let step = 0; result.json["status"] === "approval_required" && step < 8; step += 1) {
    result = await approveAndResume(result, session);
  }
  return result;
}

afterEach(cleanupE2eRoots);

describe("M2 governed vertical loop", { timeout: 120_000 }, () => {
  it("runs iterate through live observation, Judge, approvals, evaluation and snapshot", async () => {
    const parent = makeTempDir("harness-m2-vertical-");
    const newId = sequentialIds();
    let result = await runJson(
      ["new", "m2-loop", "--intent", "create the governed baseline", "--profile", "lite"],
      {
        cwd: parent,
        runtime: makeHarness(parent, newId).runtime,
      },
    );
    const projectRoot = join(parent, "m2-loop");
    result = await complete(result, {
      cwd: projectRoot,
      runtime: makeHarness(projectRoot, newId).runtime,
    });
    expect(result.json["status"]).toBe("ok");

    const judge = await fakeJudge();
    const secretName = "HARNESS_M2_JUDGE_KEY";
    const previousSecret = process.env[secretName];
    process.env[secretName] = "m2-e2e-secret-value";
    try {
      const providerRegistry = createTrustedProviderRegistry([
        {
          provider_ref: "m2-loopback",
          provider_identity: "provider_m2-loopback",
          endpoint: judge.endpoint,
          api_key_env: secretName,
          env_allowlist: [secretName],
          allowed_consumers: ["llm_judge"],
          allow_loopback_http: true,
        },
      ]);
      writeFileSync(
        join(projectRoot, ".harness", "runtime.json"),
        `${JSON.stringify(
          {
            runtime_config_version: 3,
            gates: [],
            judge_gates: [
              {
                gate_id: "gate_m2-judge",
                name: "M2 semantic review",
                subject_id: "test_t0001",
                requested_mandatory: false,
                provider_ref: "m2-loopback",
                model: "fake-reviewer-v1",
                prompt_version: "m2-e2e-v1",
                timeout_ms: 5_000,
                seed: 17,
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      git(projectRoot, "add", ".harness/runtime.json");
      git(projectRoot, "commit", "-m", "test: enable M2 judge fixture");

      const harness = makeHarness(projectRoot, newId, { providerRegistry });
      const session = { cwd: projectRoot, runtime: harness.runtime };
      result = await runJson(["iterate", "exercise the complete M2 governed loop"], session);
      expect(result.json["status"]).toBe("approval_required");

      const live = await new FileEventStream(projectRoot).read({ limit: 500 });
      expect(live.items.some((item) => item.event.event_type === "PhaseStarted")).toBe(true);
      expect(live.items.some((item) => item.event.event_type === "ApprovalRequired")).toBe(true);

      result = await complete(result, session);
      expect(result.json["status"], JSON.stringify(result.json, null, 2)).toBe("ok");
      expect((result.json["data"] as Record<string, unknown>)["snapshot_id"]).toEqual(
        expect.any(String),
      );
      expect(harness.executorCalls).toHaveLength(1);
      expect(judge.calls()).toBe(1);

      const finalStream = await new FileEventStream(projectRoot).read({ limit: 500 });
      expect(finalStream.items.some((item) => item.event.event_type === "GateStarted")).toBe(true);
      expect(
        finalStream.items.some(
          (item) => item.event.event_type === "GateCompleted" && item.authoritative,
        ),
      ).toBe(true);
      // Lite is kernel-only (plan T9): the evaluation module never runs, so no
      // EvaluationCompleted event exists; the judge gate evidence still does.
      expect(
        finalStream.items.some((item) => item.event.event_type === "EvaluationCompleted"),
      ).toBe(false);
      const snapshot = readLatestSnapshot(projectRoot);
      expect(snapshot?.status).toBe("completed");

      const evidence = git(
        projectRoot,
        "grep",
        "-l",
        "harness.llm-judge",
        "--",
        ".harness/artifacts/evidence",
      );
      expect(evidence).toContain(".harness/artifacts/evidence/evidence_m2-judge/");
      expect(git(projectRoot, "status", "--porcelain").trim()).toBe("");

      const reportPath = fileURLToPath(
        new URL("../../.reports/acceptance/m2-dogfood.json", import.meta.url),
      );
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            status: "passed",
            loop: ["iterate", "live", "gate/judge", "approval", "resume", "snapshot"],
            workflow_operation_id: (result.json["data"] as Record<string, unknown>)[
              "workflow_operation_id"
            ],
            iteration_id: (result.json["data"] as Record<string, unknown>)["iteration_id"],
            snapshot_id: snapshot?.snapshot_id,
            snapshot_status: snapshot?.status,
            judge_calls: judge.calls(),
            judge_evidence: evidence.trim().split(/\r?\n/u).filter(Boolean),
            authoritative_event_types: [
              ...new Set(
                finalStream.items
                  .filter((item) => item.authoritative)
                  .map((item) => item.event.event_type),
              ),
            ].sort(),
            worktree_clean: true,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } finally {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
      await close(judge.server);
    }
  });
});
