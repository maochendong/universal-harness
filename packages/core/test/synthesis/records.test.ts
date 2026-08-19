import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createProjectContextBundleRecord } from "../../src/context/records.js";
import { contentDigest } from "../../src/identity/digest.js";
import { verifyRecordEnvelope } from "../../src/schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import type { ProjectContextBundleRecord } from "../../src/schema/context.js";
import {
  GROUNDED_SYNTHESIS_SCHEMA_VERSIONS,
  type GroundedSynthesisOutput,
  type ProjectDiscoveryOutput,
} from "../../src/schema/synthesis.js";
import {
  createGroundedSynthesisRecord,
  deriveGroundedConversationId,
  deriveGroundedRunId,
  groundedSynthesisCacheKey,
  SynthesisRecordError,
} from "../../src/synthesis/records.js";
import { validateGroundedCitations } from "../../src/synthesis/citations.js";

const goldenDirectory = join(dirname(fileURLToPath(import.meta.url)), "../golden/synthesis");

function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as T;
}

const SESSION_ID = "capture-session_01K1ABCDEFGHIJKLMNO";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const BINDING_DIGEST = "1".repeat(64);

const BUDGET = {
  max_files: 8,
  max_bytes_per_source: 4096,
  max_total_bytes: 16384,
  max_summary_chars: 1000,
} as const;

function makeBundle(): ProjectContextBundleRecord {
  return createProjectContextBundleRecord({
    session_id: SESSION_ID,
    purpose: "proposal",
    project_baseline_digest: DIGEST_D,
    profile_digest: DIGEST_A,
    policy_digest: DIGEST_C,
    budget: BUDGET,
    sources: [
      {
        locator: "README.md",
        source_kind: "readme",
        source_digest: contentDigest("# Demo"),
        selection_reason: "matched default candidate for source kind readme",
        classification: "internal_project",
        summary: "# Demo",
        truncated: false,
      },
      {
        locator: "package.json",
        source_kind: "manifest",
        source_digest: contentDigest('{"name":"demo"}'),
        selection_reason: "matched default candidate for source kind manifest",
        classification: "internal_project",
        summary: '{"name":"demo"}',
        truncated: false,
      },
    ],
    exclusions: [],
  });
}

function discoveryOutput(bundle: ProjectContextBundleRecord): ProjectDiscoveryOutput {
  return {
    purpose: "project_discovery",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery,
    bundle_digest: bundle.record_digest,
    facts: [
      {
        fact: "这是一个 Node 服务项目",
        confidence: "high",
        source_refs: [
          {
            locator: "package.json",
            source_digest: contentDigest('{"name":"demo"}'),
          },
        ],
      },
    ],
    capability_candidates: [
      {
        capability_id: "impact_analysis",
        rationale: "README 描述了跨组件订单流程",
        confidence: "medium",
        source_refs: [{ locator: "README.md", source_digest: contentDigest("# Demo") }],
      },
    ],
    gate_candidates: [
      {
        gate_id: "unit-tests",
        rationale: "package.json 声明了 test 脚本",
        confidence: "low",
        source_refs: [{ locator: "package.json", source_digest: contentDigest('{"name":"demo"}') }],
      },
    ],
  };
}

function goldenRecord(): ReturnType<typeof createGroundedSynthesisRecord> {
  const bundle = makeBundle();
  const conversation_id = deriveGroundedConversationId({
    purpose: "project_discovery",
    binding_digest: BINDING_DIGEST,
    bundle_digest: bundle.record_digest,
  });
  const input_digest = contentDigest({
    purpose: "project_discovery",
    schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.project_discovery,
    binding_digest: BINDING_DIGEST,
    bundle_digest: bundle.record_digest,
  });
  return createGroundedSynthesisRecord({
    purpose: "project_discovery",
    session_id: SESSION_ID,
    profile_decision_digest: DIGEST_B,
    binding_digest: BINDING_DIGEST,
    bundle_digest: bundle.record_digest,
    conversation_id,
    run_id: deriveGroundedRunId({ conversation_id, input_digest }),
    input_digest,
    output: discoveryOutput(bundle),
  });
}

describe("grounded synthesis record", () => {
  it("matches the committed golden fixture", () => {
    expect(goldenRecord()).toEqual(readGolden("grounded-synthesis.json"));
  });

  it("seals a schema-valid envelope", () => {
    const record = goldenRecord();
    expect(record.record_kind).toBe("grounded_synthesis");
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("grounded-synthesis", record).valid).toBe(true);
    expect(verifyRecordEnvelope(record as unknown as Record<string, unknown>)).toBe(true);
  });

  it("registers versioned input and output schemas for all four fixed purposes", () => {
    for (const key of [
      "project-discovery-input",
      "project-discovery-output",
      "context-enrichment-output",
      "approval-brief-output",
      "iteration-narrative-output",
    ]) {
      expect(PROTOCOL_1_1_SCHEMA_REGISTRY.has(key), key).toBe(true);
    }
  });

  it("rejects a record whose output purpose differs from the record purpose", () => {
    const bundle = makeBundle();
    expect(() =>
      createGroundedSynthesisRecord({
        purpose: "approval_brief",
        session_id: SESSION_ID,
        profile_decision_digest: DIGEST_B,
        binding_digest: BINDING_DIGEST,
        bundle_digest: bundle.record_digest,
        conversation_id: deriveGroundedConversationId({
          purpose: "approval_brief",
          binding_digest: BINDING_DIGEST,
          bundle_digest: bundle.record_digest,
        }),
        run_id: "grounded-run_01K1ABCDEFGHIJKLMNO",
        input_digest: DIGEST_D,
        output: discoveryOutput(bundle),
      }),
    ).toThrow(SynthesisRecordError);
  });

  it("rejects output schema versions that are not the registered purpose version", () => {
    const bundle = makeBundle();
    const output = { ...discoveryOutput(bundle), schema_version: "project-discovery.v99" };
    expect(() =>
      createGroundedSynthesisRecord({
        purpose: "project_discovery",
        session_id: SESSION_ID,
        profile_decision_digest: DIGEST_B,
        binding_digest: BINDING_DIGEST,
        bundle_digest: bundle.record_digest,
        conversation_id: deriveGroundedConversationId({
          purpose: "project_discovery",
          binding_digest: BINDING_DIGEST,
          bundle_digest: bundle.record_digest,
        }),
        run_id: "grounded-run_01K1ABCDEFGHIJKLMNO",
        input_digest: DIGEST_D,
        output: output as ProjectDiscoveryOutput,
      }),
    ).toThrow(SynthesisRecordError);
  });

  it("rejects outputs whose bundle digest differs from the record binding", () => {
    const bundle = makeBundle();
    const output = { ...discoveryOutput(bundle), bundle_digest: DIGEST_A };
    expect(() =>
      createGroundedSynthesisRecord({
        purpose: "project_discovery",
        session_id: SESSION_ID,
        profile_decision_digest: DIGEST_B,
        binding_digest: BINDING_DIGEST,
        bundle_digest: bundle.record_digest,
        conversation_id: deriveGroundedConversationId({
          purpose: "project_discovery",
          binding_digest: BINDING_DIGEST,
          bundle_digest: bundle.record_digest,
        }),
        run_id: "grounded-run_01K1ABCDEFGHIJKLMNO",
        input_digest: DIGEST_D,
        output,
      }),
    ).toThrow(SynthesisRecordError);
  });

  it("rejects a dynamically injected purpose outside the fixed four", () => {
    const bundle = makeBundle();
    const output = {
      purpose: "data_exfiltration",
      schema_version: "dynamic.v1",
      bundle_digest: bundle.record_digest,
    };
    expect(
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("grounded-synthesis", {
        ...goldenRecord(),
        purpose: "data_exfiltration",
        output,
      }).valid,
    ).toBe(false);
    expect(
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("project-discovery-output", output as unknown as object)
        .valid,
    ).toBe(false);
  });

  it("rejects outputs that try to carry authoritative writes", () => {
    const bundle = makeBundle();
    const output = {
      ...discoveryOutput(bundle),
      capability_plan: { capabilities: [] },
    };
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("project-discovery-output", output).valid).toBe(
      false,
    );
  });

  it("derives distinct conversation identities per purpose for the same bundle", () => {
    const bundle = makeBundle();
    const ids = new Set(
      (
        [
          "project_discovery",
          "context_enrichment",
          "approval_brief",
          "iteration_narrative",
        ] as const
      ).map((purpose) =>
        deriveGroundedConversationId({
          purpose,
          binding_digest: BINDING_DIGEST,
          bundle_digest: bundle.record_digest,
        }),
      ),
    );
    expect(ids.size).toBe(4);
  });

  it("includes the purpose in every cache key", () => {
    const bundle = makeBundle();
    const base = {
      binding_digest: BINDING_DIGEST,
      bundle_digest: bundle.record_digest,
      input_digest: DIGEST_D,
    };
    const discoveryKey = groundedSynthesisCacheKey({ purpose: "project_discovery", ...base });
    const briefKey = groundedSynthesisCacheKey({ purpose: "approval_brief", ...base });
    expect(discoveryKey).not.toBe(briefKey);
  });
});

describe("citation validator", () => {
  it("accepts outputs whose claims all cite the current bundle", () => {
    const bundle = makeBundle();
    expect(validateGroundedCitations(discoveryOutput(bundle), bundle)).toEqual([]);
  });

  it("rejects claims without any source reference", () => {
    const bundle = makeBundle();
    const output = discoveryOutput(bundle);
    const broken = {
      ...output,
      facts: [{ ...output.facts[0]!, source_refs: [] }],
    } as unknown as ProjectDiscoveryOutput;
    expect(validateGroundedCitations(broken, bundle)).toEqual([
      expect.objectContaining({ code: "citation_missing" }),
    ]);
  });

  it("rejects references to locators outside the current bundle", () => {
    const bundle = makeBundle();
    const output = discoveryOutput(bundle);
    const broken: ProjectDiscoveryOutput = {
      ...output,
      facts: [
        {
          ...output.facts[0]!,
          source_refs: [{ locator: "docs/elsewhere.md", source_digest: DIGEST_A }],
        },
      ],
    };
    expect(validateGroundedCitations(broken, bundle)).toEqual([
      expect.objectContaining({ code: "citation_invalid" }),
    ]);
  });

  it("rejects references whose source digest no longer matches the bundle", () => {
    const bundle = makeBundle();
    const output = discoveryOutput(bundle);
    const broken: ProjectDiscoveryOutput = {
      ...output,
      facts: [
        {
          ...output.facts[0]!,
          source_refs: [{ locator: "README.md", source_digest: DIGEST_B }],
        },
      ],
    };
    expect(validateGroundedCitations(broken, bundle)).toEqual([
      expect.objectContaining({ code: "citation_invalid" }),
    ]);
  });

  it("rejects outputs bound to a different bundle", () => {
    const bundle = makeBundle();
    const broken: ProjectDiscoveryOutput = { ...discoveryOutput(bundle), bundle_digest: DIGEST_A };
    expect(validateGroundedCitations(broken, bundle)).toEqual([
      expect.objectContaining({ code: "citation_invalid" }),
    ]);
  });

  it("validates claims of every fixed purpose, not just discovery", () => {
    const bundle = makeBundle();
    const badRef = { locator: "README.md", source_digest: DIGEST_B };
    const outputs: GroundedSynthesisOutput[] = [
      {
        purpose: "context_enrichment",
        schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.context_enrichment,
        bundle_digest: bundle.record_digest,
        terms: [{ term: "订单", definition: "Order", source_refs: [badRef] }],
        segment_summaries: [],
        relevance_explanations: [],
      },
      {
        purpose: "approval_brief",
        schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.approval_brief,
        bundle_digest: bundle.record_digest,
        changes: [{ summary: "新增幂等重试", source_refs: [badRef] }],
        risks: [],
        tradeoffs: [],
        open_questions: [],
      },
      {
        purpose: "iteration_narrative",
        schema_version: GROUNDED_SYNTHESIS_SCHEMA_VERSIONS.iteration_narrative,
        bundle_digest: bundle.record_digest,
        outcomes: [{ summary: "完成", source_refs: [badRef] }],
        residual_risks: [],
        follow_ups: [],
      },
    ];
    for (const output of outputs) {
      const issues = validateGroundedCitations(output, bundle);
      expect(issues.length, output.purpose).toBeGreaterThan(0);
      expect(issues[0]).toMatchObject({ code: "citation_invalid" });
    }
  });
});
