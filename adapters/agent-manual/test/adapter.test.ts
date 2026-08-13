import { describe, expect, it } from "vitest";

import type { AgentEvidenceLocator } from "@universal-harness-internal/plugin-sdk";

import {
  fixtureEnvelope,
  manifestFromProfile,
  MANUAL_PROFILE,
} from "../../../tests/helpers/agent-profiles.js";
import {
  createManualAgentAdapter,
  type ManualHandoffRequest,
  type ManualHandoffResponse,
} from "../src/adapter.js";

const EVIDENCE: AgentEvidenceLocator = {
  kind: "attestation",
  locator: "evidence/review.txt",
  digest: "c".repeat(64),
};

function completedResponse(overrides: Partial<ManualHandoffResponse> = {}): ManualHandoffResponse {
  return { status: "completed", summary: "done by hand", evidence: [EVIDENCE], ...overrides };
}

function adapterWith(
  response: ManualHandoffResponse | ((request: ManualHandoffRequest) => ManualHandoffResponse),
  clock: () => number = () => 1000,
) {
  const requests: ManualHandoffRequest[] = [];
  const adapter = createManualAgentAdapter({
    handoff: (request) => {
      requests.push(request);
      return Promise.resolve(typeof response === "function" ? response(request) : response);
    },
    clock,
  });
  return { adapter, requests };
}

describe("manual agent adapter manifest", () => {
  it("declares the manual control profile with explicit resume", () => {
    const { adapter } = adapterWith(completedResponse());
    expect(adapter.manifest).toEqual(manifestFromProfile("manual", MANUAL_PROFILE, "explicit"));
  });
});

describe("manual handoff", () => {
  it("renders a self-contained handoff package from the envelope", async () => {
    const { adapter, requests } = adapterWith(completedResponse());
    const envelope = fixtureEnvelope();
    await adapter.run(envelope, { mode: "supervised" });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.envelope).toBe(envelope);
    expect(request?.resume).toBeNull();
    const brief = request?.instructions ?? "";
    expect(brief).toContain("Implement the greeting module");
    expect(brief).toContain("A greeting module with tests");
    expect(brief).toContain("- greeting module exists");
    expect(brief).toContain("Proposed write paths: src");
    expect(brief).toContain(envelope.digest);
    expect(brief).toContain(envelope.baseline_commit);
  });

  it("maps a completed handoff to a completion claim with attached evidence", async () => {
    const { adapter } = adapterWith(completedResponse());
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });

    // A claim, never a self-minted success: verification belongs to the Harness.
    expect(result.outcome).toBe("handoff");
    expect(result.termination_reason).toBe("completion");
    expect(result.completion_claimed).toBe(true);
    expect(result.evidence).toEqual([EVIDENCE]);
    expect(result.summary).toBe("done by hand");
  });

  it("rejects a completed handoff without evidence instead of trusting it", async () => {
    const { adapter } = adapterWith(completedResponse({ evidence: [] }));
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });

    expect(result.outcome).toBe("failed");
    expect(result.termination_reason).toBe("adapter_failure");
    expect(result.completion_claimed).toBe(false);
    expect(result.summary).toContain("evidence");
  });

  it("rejects evidence entries without a content digest", async () => {
    const { adapter } = adapterWith(
      completedResponse({
        evidence: [{ kind: "attestation", locator: "x", digest: "not-a-digest" }],
      }),
    );
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("failed");
    expect(result.termination_reason).toBe("adapter_failure");
  });

  it("maps a blocked handoff to failed/manual_stop", async () => {
    const { adapter } = adapterWith({ status: "blocked", summary: "need access", evidence: [] });
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("failed");
    expect(result.termination_reason).toBe("manual_stop");
    expect(result.completion_claimed).toBe(false);
  });

  it("maps a deferred handoff to a resumable handoff outcome", async () => {
    const { adapter } = adapterWith({ status: "deferred", summary: "paused", evidence: [] });
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.outcome).toBe("handoff");
    expect(result.termination_reason).toBe("manual_stop");
    expect(result.completion_claimed).toBe(false);
  });

  it("keeps only declared state proposal fields and reports the dropped ones", async () => {
    const { adapter } = adapterWith(
      completedResponse({
        state_proposal: { summary: "done", open_questions: ["q1"], budget_use: { tokens: 5 } },
      }),
    );
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.state_proposal).toEqual({ summary: "done", open_questions: ["q1"] });
    expect(result.dropped_proposal_fields).toEqual(["budget_use"]);
  });

  it("reports unmetered usage with a Harness-measured duration", async () => {
    let now = 500;
    const { adapter } = adapterWith(
      () => {
        now += 250;
        return completedResponse();
      },
      () => now,
    );
    const result = await adapter.run(fixtureEnvelope(), { mode: "supervised" });
    expect(result.usage.metering).toBe("unmetered");
    expect(result.usage.total_tokens).toBeNull();
    expect(result.usage.duration_ms).toBe(250);
  });
});

describe("explicit resume", () => {
  it("folds the resume context into the next handoff package", async () => {
    const { adapter, requests } = adapterWith(completedResponse());
    const prior: AgentEvidenceLocator = {
      kind: "attestation",
      locator: "evidence/partial.txt",
      digest: "d".repeat(64),
    };
    await adapter.run(fixtureEnvelope(), {
      mode: "supervised",
      resume: { note: "continue from the paused run", prior_evidence: [prior] },
    });
    expect(requests[0]?.resume).toEqual({
      note: "continue from the paused run",
      prior_evidence: [prior],
    });
  });
});

describe("unattended refusal", () => {
  it("never runs unattended and never calls the handoff channel", async () => {
    const { adapter, requests } = adapterWith(completedResponse());
    const result = await adapter.run(fixtureEnvelope(), { mode: "unattended" });

    expect(result.outcome).toBe("correct_block");
    expect(result.termination_reason).toBe("policy_denial");
    expect(result.summary).toContain("never unattended");
    expect(requests).toHaveLength(0);
  });
});
