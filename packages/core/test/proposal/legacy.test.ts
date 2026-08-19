import { describe, expect, it } from "vitest";

import {
  CaptureConfigurationError,
  LEGACY_NO_PROPOSAL,
  buildLegacyTemplateInput,
  createLegacyIntentInterpreterAdapter,
  resolveCaptureProposalAdapter,
} from "../../src/proposal/legacy.js";
import type { PrdProposalPort } from "../../src/proposal/port.js";
import type { CaptureUxTelemetryEvent } from "../../src/proposal/telemetry.js";
import { createManualPrdProposalAdapter } from "../../src/proposal/manual.js";
import { makeProposalInput, makeSession, makeValidDraft } from "./helpers.js";

describe("createLegacyIntentInterpreterAdapter", () => {
  it("maps InterpretedIntent deterministically without guessing new required fields", async () => {
    const session = makeSession();
    const adapter = createLegacyIntentInterpreterAdapter({
      interpreter: () => ({
        requirements: [
          {
            statement: "The user can export the monthly report as a CSV file.",
            acceptance: [
              {
                description: "exporting produces a CSV with the report rows",
                verification: "compare the CSV rows with the report data",
              },
            ],
          },
        ],
        constraints: [
          { statement: "Exports run in the batch window.", verification: "batch log review" },
        ],
      }),
    });
    expect(adapter.name).toBe("legacy-intent-interpreter");
    const result = await adapter.propose(makeProposalInput(session));
    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") throw new Error("expected a draft");
    const draft = result.draft;
    // verbatim deterministic mapping
    expect(draft.requirements[0]?.statement).toBe(
      "The user can export the monthly report as a CSV file.",
    );
    expect(draft.acceptance_criteria[0]?.action).toBe(
      "exporting produces a CSV with the report rows",
    );
    expect(draft.acceptance_criteria[0]?.verification_intent).toBe(
      "compare the CSV rows with the report data",
    );
    expect(draft.constraints[0]?.statement).toBe("Exports run in the batch window.");
    expect(draft.constraints[0]?.verification_intent).toBe("batch log review");
    // required Protocol 1.1 fields the legacy interface cannot express are
    // never guessed — the hard gates will turn them into typed questions
    expect(draft.problem_statement).toBe("");
    expect(draft.goals).toEqual([]);
    expect(draft.risks).toEqual([]);
    // lineage is declared, never canonical ids
    expect(draft.requirements[0]?.lineage).toEqual({ kind: "new" });
    expect(draft.requirements[0]?.proposed_source_bindings).toEqual([
      { source_kind: "intent", source_id: "intent", source_digest: session.intent_digest },
    ]);
    // criterion references use draft keys
    expect(draft.acceptance_criteria[0]?.requirement_id).toBe(draft.requirements[0]?.draft_key);
  });

  it("maps ClarificationOffer to typed question drafts with the other escape", async () => {
    const session = makeSession();
    const adapter = createLegacyIntentInterpreterAdapter({
      interpreter: () => ({
        clarification: [
          {
            subject: "requirement",
            index: 0,
            question: "Which reports are in scope?",
            options: ["monthly", "weekly"],
          },
          { subject: "intent", question: "What problem does this solve?" },
        ],
      }),
    });
    const result = await adapter.propose(makeProposalInput(session));
    expect(result.status).toBe("clarification_required");
    if (result.status !== "clarification_required") throw new Error("expected questions");
    const [scoped, open] = result.questions;
    expect(scoped?.target_kind).toBe("requirement");
    expect(scoped?.target_id).toBe("legacy-requirement-0");
    expect(scoped?.required).toBe(true);
    expect(scoped?.options?.map((option) => option.option_id)).toEqual([
      "option-1",
      "option-2",
      "other",
    ]);
    expect(open?.target_kind).toBe("intent");
    expect(open?.options).toBeUndefined();
  });

  it("refuses malformed clarification offers instead of completing silently", async () => {
    const session = makeSession();
    const adapter = createLegacyIntentInterpreterAdapter({
      interpreter: () => ({
        clarification: [{ subject: "intent", question: "Pick one", options: ["only-one"] }],
      }),
    });
    const result = await adapter.propose(makeProposalInput(session));
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "invalid_output", retryable: false },
    });
  });

  it("maps undefined to legacy_no_proposal and never wraps a generic requirement", async () => {
    const session = makeSession();
    const adapter = createLegacyIntentInterpreterAdapter({ interpreter: () => undefined });
    const result = await adapter.propose(makeProposalInput(session));
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: LEGACY_NO_PROPOSAL, retryable: false },
    });
  });

  it("sanitizes a throwing interpreter into a typed failure", async () => {
    const session = makeSession();
    const adapter = createLegacyIntentInterpreterAdapter({
      interpreter: () => {
        throw new Error("provider exploded with /secret/path");
      },
    });
    const result = await adapter.propose(makeProposalInput(session));
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.failure.code).toBe("provider_unavailable");
    expect(result.failure.retryable).toBe(true);
  });

  it("records the fixed template digest as invocation evidence and never in the draft", async () => {
    const session = makeSession();
    const digests: string[] = [];
    const adapter = createLegacyIntentInterpreterAdapter({
      interpreter: () => undefined,
      onTemplateInput: (digest) => digests.push(digest),
    });
    const input = makeProposalInput(session);
    await adapter.propose(input);
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatch(/^[a-f0-9]{64}$/u);
    // deterministic template
    await adapter.propose(input);
    expect(digests[1]).toBe(digests[0]);
  });

  it("builds the multi-round template from intent, answers, context and feedback", async () => {
    const session = makeSession();
    let seen = "";
    const adapter = createLegacyIntentInterpreterAdapter({
      interpreter: (intent) => {
        seen = intent;
        return undefined;
      },
    });
    const template = buildLegacyTemplateInput(makeProposalInput(session));
    await adapter.propose(makeProposalInput(session));
    expect(seen).toBe(template);
    expect(template).toContain("[intent]");
    expect(template).toContain(session.intent_text);
    expect(template).toContain("[answers]");
    expect(template).toContain("[context]");
    expect(template).toContain("README.md");
    expect(template).toContain("[feedback]");
  });

  it("emits deprecation telemetry for every legacy invocation", async () => {
    const session = makeSession();
    const events: CaptureUxTelemetryEvent[] = [];
    const adapter = createLegacyIntentInterpreterAdapter({
      interpreter: () => undefined,
      telemetry: (event) => events.push(event),
    });
    await adapter.propose(makeProposalInput(session));
    expect(events.map((event) => event.kind)).toContain("legacy_interpreter_invoked");
  });
});

describe("resolveCaptureProposalAdapter compatibility config", () => {
  const session = makeSession();
  const proposal: PrdProposalPort = createManualPrdProposalAdapter({
    complete: () => ({ kind: "draft", draft: makeValidDraft(session) }),
  });

  it("is a configuration error to set capture.proposal and legacy interpret together", () => {
    expect(() =>
      resolveCaptureProposalAdapter({ proposal, interpret: () => undefined }),
    ).toThrowError(CaptureConfigurationError);
    expect(() =>
      resolveCaptureProposalAdapter({ proposal, interpret: () => undefined }),
    ).toThrowError(/capture\.proposal.*interpret/iu);
  });

  it("keeps the legacy interpreter available for one major with deprecation marked", () => {
    const resolved = resolveCaptureProposalAdapter({ interpret: () => undefined });
    expect(resolved.deprecated_legacy).toBe(true);
    expect(resolved.adapter?.name).toBe("legacy-intent-interpreter");
  });

  it("passes a configured proposal port through unchanged", () => {
    const resolved = resolveCaptureProposalAdapter({ proposal });
    expect(resolved.adapter).toBe(proposal);
    expect(resolved.deprecated_legacy).toBe(false);
  });

  it("defaults to no model adapter so the Manual path is the default", () => {
    const resolved = resolveCaptureProposalAdapter({});
    expect(resolved.adapter).toBeUndefined();
    expect(resolved.deprecated_legacy).toBe(false);
  });
});
