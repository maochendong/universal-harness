import { readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../../packages/cli/src/index.js";
import {
  cleanupE2eRoots,
  makeHarness,
  makeTempDir,
  runJson,
  sequentialIds,
  type CliRun,
} from "./helpers.js";

/**
 * Generic `harness resume` E2E (plan Task 23 step 5): resuming a paused
 * operation never mints a duplicate approval request, never re-runs a
 * committed phase and never repeats the executor side effect.
 */
afterEach(cleanupE2eRoots);

interface Session {
  readonly cwd: string;
  readonly runtime: ReturnType<typeof makeHarness>["runtime"];
}

function field(result: CliRun, name: string): string {
  return (result.json["data"] as Record<string, unknown>)[name] as string;
}

async function approve(session: Session, requestId: string): Promise<void> {
  const approved = await runJson(["approve", requestId, "--decision", "approve"], session);
  expect(approved.exitCode).toBe(EXIT_CODES.ok);
}

describe("generic resume E2E", { timeout: 90000 }, () => {
  it("resumes through every approval point without duplicating authority", async () => {
    const parent = makeTempDir("harness-e2e-resume-");
    const newId = sequentialIds();

    let result = await runJson(
      ["new", "demo-app", "--intent", "build the first capability", "--profile", "lite"],
      {
        cwd: parent,
        runtime: makeHarness(parent, newId).runtime,
      },
    );
    expect(result.exitCode).toBe(EXIT_CODES.approvalRequired);
    const projectRoot = join(parent, "demo-app");
    const harness = makeHarness(projectRoot, newId);
    const session: Session = { cwd: projectRoot, runtime: harness.runtime };

    const authorizationRequest = field(result, "request_id");
    const workflowOperationId = field(result, "workflow_operation_id");
    expect(field(result, "object_type")).toBe("ExecutionAuthorizationSpec");

    // Resume without a decision: the same pending request comes back, and no
    // duplicate request is minted.
    result = await runJson(["resume", workflowOperationId], session);
    expect(result.exitCode).toBe(EXIT_CODES.approvalRequired);
    expect(field(result, "request_id")).toBe(authorizationRequest);
    const requestsDirectory = join(projectRoot, ".harness", "artifacts", "approval-requests");
    expect(readdirSync(requestsDirectory)).toHaveLength(1);

    // A repeated resume still reports the same authorization request.
    result = await runJson(["resume", workflowOperationId], session);
    expect(field(result, "request_id")).toBe(authorizationRequest);
    expect(readdirSync(requestsDirectory)).toHaveLength(1);

    // Only the explicit execution authorization lets the Agent run.
    await approve(session, authorizationRequest);
    result = await runJson(["resume", workflowOperationId], session);
    expect(result.json["status"]).toBe("ok");
    expect(typeof field(result, "snapshot_id")).toBe("string");

    // No duplicated authority or side effects: exactly one request, one
    // executor call, one run, one snapshot.
    expect(readdirSync(requestsDirectory)).toHaveLength(1);
    expect(harness.executorCalls).toHaveLength(1);
    expect(readdirSync(join(projectRoot, ".harness", "artifacts", "runs"))).toHaveLength(1);
    expect(readdirSync(join(projectRoot, ".harness", "artifacts", "snapshots"))).toHaveLength(1);
  });
});
