import { describe, expect, it } from "vitest";

import {
  CaptureConfigurationError,
  LEGACY_NO_PROPOSAL,
  buildLegacyTemplateInput,
  createLegacyIntentInterpreterAdapter,
  resolveCaptureProposalAdapter,
  type LegacyAcceptanceInput,
} from "../../src/proposal/legacy.js";
import type { PrdProposalPort } from "../../src/proposal/port.js";
import { createPrdProposalRecord } from "../../src/proposal/records.js";
import type { CaptureUxTelemetryEvent } from "../../src/proposal/telemetry.js";
import { createManualPrdProposalAdapter } from "../../src/proposal/manual.js";
import type { PrdProposalDraft, PrdProposalRecord } from "../../src/schema/proposal.js";
import type { CaptureSessionRecord } from "../../src/schema/capture.js";
import {
  ADAPTER_PROFILE_DIGEST,
  PROMPT_VERSION_DIGEST,
  makeBundle,
  makeProposalInput,
  makeSession,
  makeValidDraft,
} from "./helpers.js";

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

  it("derives criterion draft keys from content, so insertions never rotate them", async () => {
    const session = makeSession();
    const alpha = {
      description: "exporting produces a CSV with the report rows",
      verification: "compare the CSV rows with the report data",
    };
    const beta = {
      description: "the export completes within the batch window",
      verification: "inspect the batch log",
    };
    const statement = "The user can export the monthly report as a CSV file.";
    const proposeWith = (acceptance: readonly LegacyAcceptanceInput[]) =>
      createLegacyIntentInterpreterAdapter({
        interpreter: () => ({ requirements: [{ statement, acceptance }] }),
      }).propose(makeProposalInput(session));

    const first = await proposeWith([alpha, beta]);
    if (first.status !== "proposed") throw new Error("expected a draft");
    const firstKeys = first.draft.acceptance_criteria.map((criterion) => criterion.draft_key);
    for (const key of firstKeys) {
      expect(key).toMatch(/^criterion-[a-f0-9]{64}$/u);
    }

    // inserting an unrelated criterion before them must not rotate their keys
    const inserted = await proposeWith([
      { description: "a failure leaves no partial file", verification: "check the directory" },
      alpha,
      beta,
    ]);
    if (inserted.status !== "proposed") throw new Error("expected a draft");
    const insertedKeys = inserted.draft.acceptance_criteria.map((criterion) => criterion.draft_key);
    expect(insertedKeys[1]).toBe(firstKeys[0]);
    expect(insertedKeys[2]).toBe(firstKeys[1]);
    expect(insertedKeys[0]).not.toBe(firstKeys[0]);
    // requirement references still resolve through draft keys
    expect(inserted.draft.acceptance_criteria[0]?.requirement_id).toBe(
      inserted.draft.requirements[0]?.draft_key,
    );
    expect(inserted.draft.requirements[0]?.acceptance_criterion_ids).toEqual(insertedKeys);
  });

  it("continues unchanged criterion lineage so canonical ids survive revisions", async () => {
    const session = makeSession();
    const alpha = {
      description: "exporting produces a CSV with the report rows",
      verification: "compare the CSV rows with the report data",
    };
    const beta = {
      description: "the export completes within the batch window",
      verification: "inspect the batch log",
    };
    const statement = "The user can export the monthly report as a CSV file.";
    const adapter = createLegacyIntentInterpreterAdapter({
      interpreter: () => ({ requirements: [{ statement, acceptance: [alpha, beta] }] }),
    });

    const first = await adapter.propose(makeProposalInput(session));
    if (first.status !== "proposed") throw new Error("expected a draft");
    expect(first.draft.acceptance_criteria[0]?.lineage).toEqual({ kind: "new" });
    const firstRecord = commitDraft(session, first.draft, 1);
    // canonical content is sorted by criterion id, so index by action
    const firstIdByAction = new Map(
      firstRecord.content.acceptance_criteria.map((criterion) => [
        criterion.action,
        criterion.criterion_id,
      ]),
    );
    const alphaId = firstIdByAction.get(alpha.description);
    const betaId = firstIdByAction.get(beta.description);
    expect(alphaId).toMatch(/^prd-criterion_/u);
    expect(betaId).toMatch(/^prd-criterion_/u);

    // revision 2: alpha unchanged, beta reworded — only beta is re-minted
    const revised = await createLegacyIntentInterpreterAdapter({
      interpreter: () => ({
        requirements: [
          {
            statement,
            acceptance: [
              alpha,
              {
                description: "the export finishes inside the batch window",
                verification: "inspect the batch log",
              },
            ],
          },
        ],
      }),
    }).propose(makeProposalInput(session, { previous_proposal: firstRecord }));
    if (revised.status !== "proposed") throw new Error("expected a draft");
    expect(revised.draft.acceptance_criteria[0]?.lineage).toEqual({
      kind: "continues",
      previous_entity_id: alphaId,
    });
    expect(revised.draft.acceptance_criteria[1]?.lineage).toEqual({ kind: "new" });

    const secondRecord = commitDraft(session, revised.draft, 2, firstRecord);
    const secondByAction = new Map(
      secondRecord.content.acceptance_criteria.map((criterion) => [
        criterion.action,
        criterion.criterion_id,
      ]),
    );
    expect(secondByAction.get(alpha.description)).toBe(alphaId);
    expect(secondByAction.get("the export finishes inside the batch window")).not.toBe(betaId);
    expect(secondByAction.get("the export finishes inside the batch window")).toMatch(
      /^prd-criterion_[A-Za-z0-9_-]+$/u,
    );
  });
});

function commitDraft(
  session: CaptureSessionRecord,
  draft: PrdProposalDraft,
  revision: number,
  previous?: PrdProposalRecord,
): PrdProposalRecord {
  return createPrdProposalRecord({
    session,
    revision,
    draft,
    proposal_context_bundle: makeBundle(session),
    answers: [],
    ...(previous === undefined ? {} : { previous_proposal: previous }),
    adapter_profile_digest: ADAPTER_PROFILE_DIGEST,
    prompt_version_digest: PROMPT_VERSION_DIGEST,
    producer_identity: "test-producer",
    invocation_id: "capture-invocation_01K1ABCDEFGHIJKLMNO",
    conversation_id: "capture-conversation_01K1ABCDEFGHIJKLMNO",
    evidence_locator: "capture-evidence://capture-invocation_01K1ABCDEFGHIJKLMNO",
  }).record;
}

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
