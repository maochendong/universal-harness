import { describe, expect, it } from "vitest";

import {
  GROUNDED_SYNTHESIS_SCHEMA_VERSIONS,
  createInMemoryGroundedSynthesisAdapter,
  createPromptContractRegistry,
  contentDigest,
  CONTEXT_ENRICHMENT_PROMPT_CONTRACT,
  CONTEXT_ENRICHMENT_PROMPT_REGISTRATION,
  CONTEXT_ENRICHMENT_PROMPT_VERSION,
  type ContextEnrichmentOutput,
} from "../../../core/src/index.js";

import { compileContextBundle } from "../../src/context/compiler.js";
import { enrichContextBundle, enrichmentBundleView } from "../../src/context/enrichment.js";

/**
 * PG-6 context enrichment (model advisory design 10/11): the model explains
 * the deterministically selected bundle with citations into it; a citation
 * that does not resolve fails closed and the bundle itself is never
 * modified by enrichment.
 */
const digest = (letter: string) => letter.repeat(64);

function bundleRecord() {
  const nodeRecord: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: "requirement_01",
    type: "Requirement",
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "enrichment-test",
      timestamp: "2026-08-21T00:00:00Z",
    },
    confidence: 1,
  };
  const node = { ...nodeRecord, digest: contentDigest(nodeRecord) } as never;
  return compileContextBundle({
    taskId: "task_01",
    goal: "ship the export",
    bindings: {
      requirement_baseline_digest: digest("b"),
      policy_digest: digest("2"),
      plan_digest: digest("3"),
      impact_coverage_digest: digest("4"),
      task_digest: digest("5"),
      approval_digests: [],
    },
    tokenBudget: 4000,
    candidates: [{ node, content: "requirement text", tier: 1, reason: "the requirement" }],
  }).record;
}

function cleanOutput(bundleDigest: string, locator: string, sourceDigest: string) {
  return {
    purpose: "context_enrichment",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.context_enrichment,
    bundle_digest: bundleDigest,
    terms: [
      {
        term: "acceptance criterion",
        definition: "the verified outcome",
        source_refs: [{ locator, source_digest: sourceDigest }],
      },
    ],
    segment_summaries: [],
    relevance_explanations: [
      {
        locator,
        explanation: "the task implements this requirement",
        source_refs: [{ locator, source_digest: sourceDigest }],
      },
    ],
  } satisfies ContextEnrichmentOutput;
}

describe("context enrichment", () => {
  it("projects the execution bundle into a citable view", () => {
    const record = bundleRecord();
    const view = enrichmentBundleView(record);
    expect(view.purpose).toBe("context_enrichment");
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]?.locator).toContain("requirement_01");
    expect(view.record_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("persists a grounded record for cited, bundle-bound output", async () => {
    const record = bundleRecord();
    const view = enrichmentBundleView(record);
    const source = view.sources[0];
    const port = createInMemoryGroundedSynthesisAdapter(() => ({
      status: "completed",
      output: cleanOutput(view.record_digest, source?.locator ?? "", source?.source_digest ?? ""),
    }));
    const outcome = await enrichContextBundle({
      port,
      bundleRecord: record,
      conversation_id: "conversation_01K1CV1",
      run_id: "run_01K1RN1",
    });
    expect(outcome.status).toBe("enriched");
    if (outcome.status !== "enriched") return;
    expect(outcome.record.purpose).toBe("context_enrichment");
    expect(outcome.record.bundle_digest).toBe(view.record_digest);
  });

  it("fails closed on citations outside the bundle and never mutates it", async () => {
    const record = bundleRecord();
    const digestBefore = record.digest;
    const view = enrichmentBundleView(record);
    const port = createInMemoryGroundedSynthesisAdapter(() => ({
      status: "completed",
      output: cleanOutput(view.record_digest, "context://foreign/source", digest("9")),
    }));
    const outcome = await enrichContextBundle({
      port,
      bundleRecord: record,
      conversation_id: "conversation_01K1CV1",
      run_id: "run_01K1RN1",
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.failure.code).toBe("citation_invalid");
    expect(record.digest).toBe(digestBefore);
  });
});

describe("context enrichment prompt contract", () => {
  it("resolves the grounded_synthesis context_enrichment purpose", () => {
    const registry = createPromptContractRegistry([CONTEXT_ENRICHMENT_PROMPT_REGISTRATION]);
    const resolution = registry.resolve({
      port_id: "grounded_synthesis",
      purpose: "context_enrichment",
      prompt_version: CONTEXT_ENRICHMENT_PROMPT_VERSION,
    });
    expect(resolution.prompt_contract_id).toBe("harness:prompt:context-enrichment");
    expect(resolution.output_schema_id).toBe("context-enrichment-output");
    expect(resolution.prompt_contract_digest).toBe(
      CONTEXT_ENRICHMENT_PROMPT_CONTRACT.contract_digest,
    );
  });

  it("pins the explain-only authority boundary", () => {
    const text = CONTEXT_ENRICHMENT_PROMPT_CONTRACT.authority_boundary.text;
    expect(text).toContain("never remove or add a source");
    expect(text).toContain("never change a path set");
  });
});
