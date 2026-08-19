import { describe, expect, it } from "vitest";

import { createInMemoryPrdProposalAdapter } from "../../src/proposal/in-memory.js";
import {
  LEGACY_NO_PROPOSAL,
  createLegacyIntentInterpreterAdapter,
} from "../../src/proposal/legacy.js";
import { createManualPrdProposalAdapter } from "../../src/proposal/manual.js";
import {
  PRD_PORT_FAILURE_CODES,
  type PrdProposalPort,
  type PrdProposalResult,
} from "../../src/proposal/port.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import { CAPTURE_QUESTION_SOURCES } from "../../src/schema/capture.js";
import { makeProposalInput, makeSession, makeValidDraft } from "./helpers.js";

/**
 * PrdProposalPort conformance (design 9, 11.4, 20.2): every adapter — Manual,
 * in-memory, model-backed or the legacy bridge — returns only the typed
 * result union, drafts carry draft keys and lineage instead of canonical ids,
 * and failures are typed and sanitized. Adapters hold no project or ledger
 * handles by construction: their only inputs arrive through `propose`.
 */
function runProposalAdapterConformance(
  name: string,
  factory: (session: ReturnType<typeof makeSession>) => PrdProposalPort,
  failingFactory: (session: ReturnType<typeof makeSession>) => PrdProposalPort,
): void {
  describe(`PrdProposalPort conformance: ${name}`, () => {
    it("returns a schema-valid draft keyed by draft_key with declared lineage", async () => {
      const session = makeSession();
      const adapter = factory(session);
      const result: PrdProposalResult = await adapter.propose(makeProposalInput(session));
      expect(result.status).toBe("proposed");
      if (result.status !== "proposed") throw new Error("expected a draft");
      const validation = PROTOCOL_1_1_SCHEMA_REGISTRY.validate("prd-proposal-draft", result.draft);
      expect(validation.valid).toBe(true);
      for (const entity of [
        ...result.draft.goals,
        ...result.draft.requirements,
        ...result.draft.acceptance_criteria,
      ]) {
        expect(entity.draft_key).toBeTruthy();
        expect(entity.lineage.kind === "new" || entity.lineage.kind === "continues").toBe(true);
        expect("id" in entity).toBe(false);
        expect("criterion_id" in entity).toBe(false);
        expect("source_bindings" in entity).toBe(false);
      }
      // the draft is the only output: no canonical ids, state or approval
      expect("proposal_id" in result.draft).toBe(false);
      expect("accepted" in result).toBe(false);
      expect("next_state" in result).toBe(false);
    });

    it("returns typed, sanitized failures from the shared failure contract", async () => {
      const session = makeSession();
      const adapter = failingFactory(session);
      const result = await adapter.propose(makeProposalInput(session));
      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("expected failure");
      expect([...PRD_PORT_FAILURE_CODES, LEGACY_NO_PROPOSAL]).toContain(result.failure.code);
      expect(typeof result.failure.retryable).toBe("boolean");
      expect(result.failure.summary.length).toBeGreaterThan(0);
    });
  });
}

runProposalAdapterConformance(
  "manual",
  (session) =>
    createManualPrdProposalAdapter({
      complete: () => ({ kind: "draft", draft: makeValidDraft(session) }),
    }),
  () =>
    createManualPrdProposalAdapter({
      complete: () => {
        throw new Error("ui exploded");
      },
    }),
);

runProposalAdapterConformance(
  "in-memory",
  (session) =>
    createInMemoryPrdProposalAdapter(() => ({
      status: "proposed",
      draft: makeValidDraft(session),
    })),
  () =>
    createInMemoryPrdProposalAdapter(() => ({
      status: "failed",
      failure: { code: "timeout", retryable: true, summary: "timed out" },
    })),
);

runProposalAdapterConformance(
  "legacy-interpreter",
  () =>
    createLegacyIntentInterpreterAdapter({
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
      }),
    }),
  () => createLegacyIntentInterpreterAdapter({ interpreter: () => undefined }),
);

// A scripted stand-in for a model-backed adapter (DshPrdProposalAdapter lands
// with the managed invocation runner in T8-B); the conformance contract is
// identical because the port boundary is.
runProposalAdapterConformance(
  "scripted-model",
  (session) =>
    createInMemoryPrdProposalAdapter(() => ({
      status: "proposed" as const,
      draft: makeValidDraft(session),
    })),
  () =>
    createInMemoryPrdProposalAdapter(() => ({
      status: "failed" as const,
      failure: { code: "invalid_output" as const, retryable: true, summary: "invalid json" },
    })),
);

describe("PrdProposalPort conformance: clarification results", () => {
  it("clarification drafts stay inside the typed question contract", async () => {
    const session = makeSession();
    const adapter = createInMemoryPrdProposalAdapter(() => ({
      status: "clarification_required",
      questions: [
        {
          source: "proposal" as const,
          target_kind: "requirement" as const,
          missing_dimension: "scope",
          question: "Which reports are in scope?",
          required: true,
        },
      ],
    }));
    const result = await adapter.propose(makeProposalInput(session));
    expect(result.status).toBe("clarification_required");
    if (result.status !== "clarification_required") throw new Error("expected questions");
    for (const question of result.questions) {
      expect(CAPTURE_QUESTION_SOURCES).toContain(question.source);
    }
  });
});
