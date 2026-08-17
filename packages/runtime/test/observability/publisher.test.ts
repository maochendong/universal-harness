import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileEventStream,
  FileLiveSpool,
  ObservationPublisher,
  gateCompletionObservationKey,
} from "../../src/index.js";

const roots: string[] = [];

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "harness-publisher-"));
  roots.push(projectRoot);
  let milliseconds = Date.parse("2026-08-16T00:00:00.000Z");
  const secrets = new Map([["API_TOKEN", "secret-value-123"]]);
  const publisher = new ObservationPublisher(
    new FileLiveSpool(projectRoot, { secrets }),
    {
      projectId: "project_01",
      iterationId: "iteration_01",
      workflowOperationId: "workflow_01",
      attemptId: "attempt_01",
    },
    { now: () => new Date(milliseconds).toISOString(), nowMs: () => milliseconds, secrets },
  );
  return {
    projectRoot,
    publisher,
    advance: (amount: number) => {
      milliseconds += amount;
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ObservationPublisher", () => {
  it("publishes ordered phase, gate, run, budget and approval observations", async () => {
    const { projectRoot, publisher, advance } = fixture();

    publisher.phaseStarted("execute");
    publisher.runStarted("run_01", { task_id: "task_01", tool: "agent" });
    expect(publisher.runHeartbeat("run_01")).toBeDefined();
    advance(4_999);
    expect(publisher.runHeartbeat("run_01")).toBeUndefined();
    advance(1);
    expect(publisher.runHeartbeat("run_01", { used_tokens: 20 })).toBeDefined();
    publisher.budgetUpdated({ used_steps: 1, used_tokens: 20, ceiling_tokens: 100 });
    publisher.gateStarted("gate_test");
    const completed = publisher.gateCompleted("gate_test", { passed: true });
    publisher.approvalRequired({
      request_id: "approval_01",
      object_id: "plan_01",
      object_digest: "a".repeat(64),
      risk: "high",
      proposed_by: "agent",
    });
    publisher.phasePaused("execute", "approval_required");
    publisher.runTerminated("run_01", { outcome: "handoff" });

    const page = await new FileEventStream(projectRoot).read({ limit: 50 });
    expect(page.items.map((item) => item.event.event_type)).toEqual([
      "PhaseStarted",
      "RunStarted",
      "RunHeartbeat",
      "RunHeartbeat",
      "BudgetUpdated",
      "GateStarted",
      "GateCompleted",
      "ApprovalRequired",
      "PhasePaused",
      "RunTerminated",
    ]);
    expect(completed.observation_key).toBe(
      gateCompletionObservationKey("workflow_01", "attempt_01", "gate_test"),
    );
    expect(page.items.map((item) => item.event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("throttles output, emits at 8 KiB or two seconds, and bounds the summary", async () => {
    const { publisher, advance } = fixture();

    publisher.runStarted("run_01", { tool: "test" });
    expect(publisher.runOutput("run_01", "first line\n")).toBeUndefined();
    advance(2_000);
    const timed = publisher.runOutput("run_01", "second line\n");
    expect(timed?.payload).toMatchObject({ bytes_observed: 23, truncated: false });

    const threshold = publisher.runOutput(
      "run_01",
      `${Array.from({ length: 30 }, (_, index) => `line-${String(index)} ${"x".repeat(300)}`).join("\n")}\n`,
    );
    expect(threshold).toBeDefined();
    expect(Buffer.byteLength(String(threshold?.payload["summary"]), "utf8")).toBeLessThanOrEqual(
      4_096,
    );
    expect(String(threshold?.payload["summary"]).split("\n").length).toBeLessThanOrEqual(20);
    expect(threshold?.payload["truncated"]).toBe(true);
    expect(threshold?.payload["output_digest"]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("labels stdout, stderr and mixed summaries and marks the final flush", () => {
    const { publisher, advance } = fixture();

    publisher.runStarted("run_01");
    expect(publisher.runOutput("run_01", "compiling\n", { stream: "stdout" })).toBeUndefined();
    advance(2_000);
    const mixed = publisher.runOutput("run_01", "warning\n", { stream: "stderr" });
    expect(mixed?.payload).toMatchObject({ stream: "mixed", final: false });
    const final = publisher.runOutput("run_01", "done\n", {
      stream: "stdout",
      flush: true,
      final: true,
    });
    expect(final?.payload).toMatchObject({ stream: "mixed", final: true });
  });

  it("redacts exact secrets split across chunks, URL credentials and common token forms", async () => {
    const { projectRoot, publisher, advance } = fixture();

    publisher.runStarted("run_01", { tool: "test" });
    advance(2_000);
    const partial = publisher.runOutput("run_01", "exact=secret-");
    expect(partial?.payload["summary"]).toBe("exact=[redacted:secret]");
    publisher.runOutput(
      "run_01",
      "value-123 url=https://alice:password@example.com auth=Bearer abcdefghijklmnopqrstuvwxyz sk-1234567890abcdefghijklmnop",
      { flush: true },
    );

    const page = await new FileEventStream(projectRoot).read({ limit: 20 });
    const summary = String(page.items.at(-1)?.event.payload["summary"]);
    expect(summary).not.toContain("secret-value-123");
    expect(summary).not.toContain("alice:password");
    expect(summary).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(summary).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(summary).toContain("[redacted:secret]");
  });
});
