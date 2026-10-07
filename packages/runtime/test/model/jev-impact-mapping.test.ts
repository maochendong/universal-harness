import { describe, expect, it } from "vitest";

import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  contentDigest,
  type JevImpactJudgments,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  JEV_IMPACT_CRITERIA,
  RELATION_RULE_REGISTRY,
  type ImpactAdvisoryInput,
} from "@universal-harness-internal/graph";

import type { JevInputPreparation } from "../../src/model/jev-impact-input.js";
import {
  JevImpactMappingError,
  mapJevImpactJudgments,
} from "../../src/model/jev-impact-mapping.js";

function businessNode(id: string, statement: string): NodeRecord {
  const record = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id,
    type: "Requirement",
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: { iteration_id: "iteration_01", actor: "test", timestamp: "2026-09-28T00:00:00Z" },
    confidence: 1,
    extensions: { "harness.requirements": { statement } },
  } as const;
  return { ...record, digest: contentDigest(record) };
}

function fixture() {
  const seed = businessNode("requirement_01", "Change report export format");
  const candidate = businessNode("requirement_02", "Consume that exported report");
  const input: ImpactAdvisoryInput = {
    workflow_operation_id: "operation_01",
    iteration_id: "iteration_01",
    impact_set_digest: "a".repeat(64),
    deterministic_entries: [
      {
        node_id: seed.id,
        node_type: seed.type,
        classification: "must-change",
        risk: "medium",
        confidence: 1,
        path: [],
        reason: "seed",
        seed_id: "seed_01",
      },
    ],
    nodes: [seed, candidate],
    requirement_digests: { [seed.id]: seed.digest },
    rule_registry_version: RELATION_RULE_REGISTRY.version,
    rule_registry_digest: RELATION_RULE_REGISTRY.digest,
    conversation_id: "conversation_01",
    run_id: "run_01",
  };
  const project = (node: NodeRecord, statement: string) => ({
    id: node.id,
    type: node.type,
    revision: node.revision,
    digest: node.digest,
    fields: { "harness.requirements.statement": statement },
  });
  const candidates = [project(candidate, "Consume that exported report")];
  const prepared: Extract<JevInputPreparation, { status: "ready" }> = {
    status: "ready",
    local_diagnostic: {
      code: "candidate_scope",
      candidate_count: 1,
      excluded_count: 1,
      excluded_by_reason: { already_deterministic: 1, not_accepted: 0, unsupported_type: 0 },
    },
    request: {
      model: "jev-1.13.0",
      state: { change: project(seed, "Change report export format"), candidates },
      questions: {
        [candidate.id]: {
          type: "choice",
          instructions: "Inspect state.candidates[0] against state.change",
          criteria: JEV_IMPACT_CRITERIA,
        },
      },
    },
    binding: {
      impact_set_digest: input.impact_set_digest,
      rule_registry_version: input.rule_registry_version,
      rule_registry_digest: input.rule_registry_digest,
      candidate_set_digest: contentDigest(candidates),
      mapping_version: "jev-impact-mapping.v1",
      projection_version: "jev-impact-projection.v1",
      limits_version: "jev-impact-limits.v1",
    },
  };
  const judgments: JevImpactJudgments = {
    schema_version: "jev-impact-judgments.v1",
    provider_response: {
      model: "jev-1.13.0",
      answers: {
        [candidate.id]: {
          type: "choice",
          choice: "affected",
          probabilities: { affected: 0.91, unrelated: 0.04, insufficient: 0.05 },
          confidence: 0.86,
        },
      },
      usage: { input_tokens: 300, output_tokens: 20 },
    },
    harness: {
      request_digest: contentDigest(prepared.request),
      candidate_set_digest: prepared.binding.candidate_set_digest,
      mapping_version: "jev-impact-mapping.v1",
    },
  };
  return { input, prepared, judgments, seed, candidate };
}

describe("Jev impact judgment mapping", () => {
  it("maps an explicit affected judgment to a cited inspect suggestion without changing source facts", () => {
    const { input, prepared, judgments, seed, candidate } = fixture();
    const before = structuredClone({ input, prepared, judgments });
    const mapped = mapJevImpactJudgments(input, prepared, judgments);
    expect(mapped).toMatchObject({
      purpose: "impact_advisory",
      schema_version: "impact-advisory.v1",
      impact_set_digest: input.impact_set_digest,
      additions: [
        {
          node_id: candidate.id,
          node_type: "Requirement",
          classification: "inspect",
          risk: "medium",
          confidence: 0.9,
          source_refs: [
            { kind: "graph_node", ref: seed.id, digest: seed.digest },
            { kind: "graph_node", ref: candidate.id, digest: candidate.digest },
          ],
        },
      ],
      edge_candidates: [],
      risk_signals: [],
      missing_facts: [],
      questions: [],
    });
    expect(mapped.additions[0]?.reason).toContain("Jev 候选检查建议；建议强度非正确率");
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("impact-advisory-output", mapped).valid).toBe(
      true,
    );
    expect({ input, prepared, judgments }).toEqual(before);
  });

  it.each([
    ["affected", 0.8, 0.8, 1, 0],
    ["affected", 0.799, 0.9, 0, 1],
    ["affected", 0.9, 0.799, 0, 1],
    ["unrelated", 0.9, 0.9, 0, 0],
    ["unrelated", 0.799, 0.9, 0, 1],
    ["insufficient", 0.95, 0.95, 0, 1],
  ] as const)(
    "preserves %s uncertainty at probability %s and concentration %s",
    (choice, probability, confidence, additions, questions) => {
      const { input, prepared, judgments, candidate, seed } = fixture();
      judgments.provider_response.answers[candidate.id] = {
        type: "choice",
        choice,
        confidence,
        probabilities: {
          affected: (1 - probability) / 2,
          unrelated: (1 - probability) / 2,
          insufficient: (1 - probability) / 2,
          [choice]: probability,
        },
      };
      const mapped = mapJevImpactJudgments(input, prepared, judgments);
      expect(mapped.additions).toHaveLength(additions);
      expect(mapped.questions).toHaveLength(questions);
      expect(mapped.missing_facts).toHaveLength(questions);
      if (questions > 0) {
        expect(mapped.questions[0]?.target_id).toBe(candidate.id);
        expect(mapped.questions[0]?.question).toContain("补充");
        expect(mapped.missing_facts[0]?.source_refs).toEqual([
          { kind: "graph_node", ref: seed.id, digest: seed.digest },
          { kind: "graph_node", ref: candidate.id, digest: candidate.digest },
        ]);
      }
      expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("impact-advisory-output", mapped).valid).toBe(
        true,
      );
    },
  );

  it("withholds all additions when a second candidate needs clarification", () => {
    const { input, prepared, judgments } = fixture();
    const uncertain = businessNode("requirement_03", "Unspecified report integration");
    const candidates = [
      ...prepared.request.state.candidates,
      {
        id: uncertain.id,
        type: uncertain.type,
        revision: uncertain.revision,
        digest: uncertain.digest,
        fields: { "harness.requirements.statement": "Unspecified report integration" },
      },
    ];
    const request = {
      ...prepared.request,
      state: { ...prepared.request.state, candidates },
      questions: {
        ...prepared.request.questions,
        [uncertain.id]: {
          type: "choice" as const,
          instructions: "Inspect state.candidates[1]",
          criteria: JEV_IMPACT_CRITERIA,
        },
      },
    };
    const combined = {
      ...prepared,
      request,
      binding: { ...prepared.binding, candidate_set_digest: contentDigest(candidates) },
    };
    const raw: JevImpactJudgments = {
      ...judgments,
      harness: {
        ...judgments.harness,
        request_digest: contentDigest(request),
        candidate_set_digest: combined.binding.candidate_set_digest,
      },
      provider_response: {
        ...judgments.provider_response,
        answers: {
          ...judgments.provider_response.answers,
          [uncertain.id]: {
            type: "choice",
            choice: "insufficient",
            confidence: 0.9,
            probabilities: { affected: 0.05, unrelated: 0.05, insufficient: 0.9 },
          },
        },
      },
    };
    const mapped = mapJevImpactJudgments(
      { ...input, nodes: [...input.nodes, uncertain] },
      combined,
      raw,
    );
    expect(mapped.additions).toEqual([]);
    expect(mapped.questions).toHaveLength(1);
    expect(mapped.questions[0]?.target_id).toBe(uncertain.id);
  });

  const invalidResults: readonly [string, (value: JevImpactJudgments) => void][] = [
    [
      "wrong model",
      (value) => {
        Object.assign(value.provider_response, { model: "jev-latest" });
      },
    ],
    [
      "unknown field",
      (value) => {
        Object.assign(value, { explanation: "invented" });
      },
    ],
    [
      "missing answer",
      (value) => {
        delete value.provider_response.answers["requirement_02"];
      },
    ],
    [
      "extra answer",
      (value) => {
        value.provider_response.answers["requirement_03"] =
          value.provider_response.answers["requirement_02"]!;
      },
    ],
    [
      "wrong probability sum",
      (value) => {
        value.provider_response.answers["requirement_02"]!.probabilities.affected = 0.7;
      },
    ],
    [
      "non-maximal choice",
      (value) => {
        value.provider_response.answers["requirement_02"]!.choice = "unrelated";
      },
    ],
    [
      "infinite confidence",
      (value) => {
        value.provider_response.answers["requirement_02"]!.confidence = Infinity;
      },
    ],
    [
      "NaN probability",
      (value) => {
        value.provider_response.answers["requirement_02"]!.probabilities.affected = NaN;
      },
    ],
    [
      "confidence outside range",
      (value) => {
        value.provider_response.answers["requirement_02"]!.confidence = 1.1;
      },
    ],
    [
      "negative usage",
      (value) => {
        value.provider_response.usage.input_tokens = -1;
      },
    ],
    [
      "unsafe token sum",
      (value) => {
        value.provider_response.usage.input_tokens = Number.MAX_SAFE_INTEGER;
      },
    ],
  ];

  it.each(invalidResults)(
    "rejects cached %s before producing a domain result",
    (_label, corrupt) => {
      const { input, prepared, judgments } = fixture();
      corrupt(judgments);
      expect(() => mapJevImpactJudgments(input, prepared, judgments)).toThrow(
        JevImpactMappingError,
      );
    },
  );

  const driftCases: readonly [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      "request digest",
      (value) => {
        value.judgments.harness.request_digest = "b".repeat(64);
      },
    ],
    [
      "result candidate digest",
      (value) => {
        value.judgments.harness.candidate_set_digest = "b".repeat(64);
      },
    ],
    [
      "bound candidate digest",
      (value) => {
        Object.assign(value.prepared.binding, { candidate_set_digest: "b".repeat(64) });
      },
    ],
    [
      "impact digest",
      (value) => {
        Object.assign(value.prepared.binding, { impact_set_digest: "b".repeat(64) });
      },
    ],
    [
      "rule version",
      (value) => {
        Object.assign(value.prepared.binding, { rule_registry_version: "unknown" });
      },
    ],
    [
      "rule digest",
      (value) => {
        Object.assign(value.prepared.binding, { rule_registry_digest: "b".repeat(64) });
      },
    ],
    [
      "mapping version",
      (value) => {
        Object.assign(value.prepared.binding, { mapping_version: "jev-impact-mapping.v2" });
      },
    ],
    [
      "missing graph node",
      (value) => {
        Object.assign(value.input, { nodes: [value.seed] });
      },
    ],
    [
      "graph node revision",
      (value) => {
        value.candidate.revision = 2;
      },
    ],
    [
      "graph node type",
      (value) => {
        value.candidate.type = "Constraint";
      },
    ],
    [
      "graph node content",
      (value) => {
        value.candidate.extensions = {
          "harness.requirements": { statement: "Changed without updating digest" },
        };
      },
    ],
    [
      "duplicate graph id",
      (value) => {
        Object.assign(value.input, { nodes: [...value.input.nodes, value.candidate] });
      },
    ],
    [
      "seed identity",
      (value) => {
        Object.assign(value.input.deterministic_entries[0]!, { node_id: value.candidate.id });
      },
    ],
    [
      "no risk baseline",
      (value) => {
        Object.assign(value.input, { deterministic_entries: [] });
      },
    ],
    [
      "candidate already deterministic",
      (value) => {
        Object.assign(value.input, {
          deterministic_entries: [
            ...value.input.deterministic_entries,
            {
              ...value.input.deterministic_entries[0]!,
              node_id: value.candidate.id,
              path: ["edge_01"],
            },
          ],
        });
      },
    ],
  ];

  it.each(driftCases)(
    "rejects %s drift rather than attaching an unverifiable citation",
    (_label, corrupt) => {
      const value = fixture();
      corrupt(value);
      expect(() => mapJevImpactJudgments(value.input, value.prepared, value.judgments)).toThrow(
        JevImpactMappingError,
      );
    },
  );

  it.each(["type", "revision", "duplicate"] as const)(
    "rejects projected %s even when the result is rehashed consistently",
    (kind) => {
      const { input, prepared, judgments } = fixture();
      const projected = prepared.request.state.candidates[0]!;
      if (kind === "type") Object.assign(projected, { type: "Constraint" });
      else if (kind === "revision") Object.assign(projected, { revision: 2 });
      else Object.assign(prepared.request.state, { candidates: [projected, projected] });
      Object.assign(prepared.binding, {
        candidate_set_digest: contentDigest(prepared.request.state.candidates),
      });
      judgments.harness.request_digest = contentDigest(prepared.request);
      judgments.harness.candidate_set_digest = prepared.binding.candidate_set_digest;
      expect(() => mapJevImpactJudgments(input, prepared, judgments)).toThrow(
        JevImpactMappingError,
      );
    },
  );

  it("uses the highest deterministic risk without modifying deterministic entries", () => {
    const { input, prepared, judgments } = fixture();
    const existing = businessNode("requirement_03", "Protect report export access");
    const highRiskInput: ImpactAdvisoryInput = {
      ...input,
      nodes: [...input.nodes, existing],
      deterministic_entries: [
        ...input.deterministic_entries,
        {
          ...input.deterministic_entries[0]!,
          node_id: existing.id,
          risk: "high",
          path: ["edge_01"],
        },
      ],
    };
    const before = structuredClone(highRiskInput.deterministic_entries);
    expect(mapJevImpactJudgments(highRiskInput, prepared, judgments).additions[0]?.risk).toBe(
      "high",
    );
    expect(highRiskInput.deterministic_entries).toEqual(before);
  });

  it("changes domain digest only when the discrete suggestion strength changes", () => {
    const { input, prepared, judgments, candidate } = fixture();
    const original = mapJevImpactJudgments(input, prepared, judgments);
    const sameBucket = structuredClone(judgments);
    sameBucket.provider_response.answers[candidate.id] = {
      type: "choice",
      choice: "affected",
      confidence: 0.95,
      probabilities: { affected: 0.99, unrelated: 0.005, insufficient: 0.005 },
    };
    sameBucket.provider_response.usage.input_tokens = 1000;
    expect(mapJevImpactJudgments(input, prepared, sameBucket)).toEqual(original);
    const lowerBucket = structuredClone(judgments);
    lowerBucket.provider_response.answers[candidate.id]!.probabilities = {
      affected: 0.89,
      unrelated: 0.06,
      insufficient: 0.05,
    };
    const lower = mapJevImpactJudgments(input, prepared, lowerBucket);
    expect(lower.additions[0]?.confidence).toBe(0.8);
    expect(contentDigest(lower)).not.toBe(contentDigest(original));
    expect(judgments.provider_response.answers[candidate.id]?.probabilities.affected).toBe(0.91);
  });

  it.each([
    [{ affected: 0.8, unrelated: 0.1, insufficient: 0.102 }, true],
    [{ affected: 0.8, unrelated: 0.1, insufficient: 0.1021 }, false],
    [{ affected: 0.5, unrelated: 0.5, insufficient: 0 }, true],
  ] as const)("revalidates cached probability tolerance and ties %#", (probabilities, valid) => {
    const { input, prepared, judgments, candidate } = fixture();
    judgments.provider_response.answers[candidate.id]!.probabilities = probabilities;
    if (valid) expect(() => mapJevImpactJudgments(input, prepared, judgments)).not.toThrow();
    else
      expect(() => mapJevImpactJudgments(input, prepared, judgments)).toThrow(
        JevImpactMappingError,
      );
    expect(judgments.provider_response.answers[candidate.id]?.probabilities).toEqual(probabilities);
  });
});
