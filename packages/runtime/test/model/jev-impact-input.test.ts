import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  contentDigest,
  createPromptContractRegistry,
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  type NodeRecord,
} from "@universal-harness-internal/core";
import {
  JEV_IMPACT_PROMPT_REGISTRATION,
  JEV_IMPACT_PROMPT_VERSION,
  RELATION_RULE_REGISTRY,
  type ImpactAdvisoryInput,
} from "@universal-harness-internal/graph";

import { prepareJevImpactInput } from "../../src/model/jev-impact-input.js";
import { PromptPreparationFailureError } from "../../src/model/capture-adapters.js";
import { compilePrompt } from "../../src/model/prompt-compiler.js";
import { buildJevInputBundle } from "../../src/model/jev-impact-provider.js";
import { jevInput, jevNode, jevRegistry } from "./jev-fixtures.js";

function businessNode(id: string, statement: string): NodeRecord {
  const record = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id,
    type: "Requirement",
    revision: 1,
    status: "accepted",
    source: "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "test",
      timestamp: "2026-09-28T00:00:00Z",
    },
    confidence: 1,
    extensions: { "harness.requirements": { statement } },
  } as const;
  return { ...record, digest: contentDigest(record) };
}

describe("Jev impact input preparation", () => {
  it("wraps a missing contract as a typed preparation failure and preserves unexpected errors", () => {
    expect(() =>
      prepareJevImpactInput(jevInput(), createPromptContractRegistry([]), "standard"),
    ).toThrowError(
      expect.objectContaining({
        name: "PromptPreparationFailureError",
        failure: expect.objectContaining({
          code: "prompt_contract_version_mismatch",
          retryable: false,
        }),
      }),
    );
    const unexpected = new Error("registry implementation bug");
    expect(() =>
      prepareJevImpactInput(
        jevInput(),
        {
          contracts: [],
          resolve() {
            throw unexpected;
          },
        },
        "standard",
      ),
    ).toThrow(unexpected);
  });

  it.each(["multiple", "unsupported", "stale_node", "duplicate", "entry_type", "unaccepted"])(
    "rejects invalid authoritative input: %s",
    (kind) => {
      let input = jevInput();
      if (kind === "multiple")
        input = {
          ...input,
          deterministic_entries: [
            ...input.deterministic_entries,
            { ...input.deterministic_entries[0]!, node_id: "requirement_consumer" },
          ],
        };
      if (kind === "unsupported")
        input = jevInput([
          jevNode("decision_seed", {
            type: "Decision",
            extensions: { "harness.decision": { summary: "change architecture" } },
          }),
        ]);
      if (kind === "stale_node")
        input = {
          ...input,
          nodes: [{ ...input.nodes[0]!, digest: "f".repeat(64) }, input.nodes[1]!],
        };
      if (kind === "duplicate") input = { ...input, nodes: [...input.nodes, input.nodes[1]!] };
      if (kind === "entry_type")
        input = {
          ...input,
          deterministic_entries: [{ ...input.deterministic_entries[0]!, node_type: "Test" }],
        };
      if (kind === "unaccepted")
        input = jevInput([jevNode("requirement_seed", { status: "proposed" })]);
      expect(prepareJevImpactInput(input, jevRegistry(), "standard")).toMatchObject({
        status: "failed",
        failure: { code: "policy_denied", retryable: false },
      });
    },
  );

  it("excludes non-accepted and non-business nodes and treats an empty candidate set locally", () => {
    const seed = jevNode("requirement_seed");
    const excluded = [
      jevNode("requirement_proposed", { status: "proposed" }),
      jevNode("requirement_old", { status: "superseded" }),
      jevNode("run_01", { type: "Run" }),
    ];
    expect(prepareJevImpactInput(jevInput([seed, ...excluded]), jevRegistry(), "lite")).toEqual({
      status: "no_candidates",
      excluded_count: 4,
      local_diagnostic: {
        code: "no_candidates",
        candidate_count: 0,
        excluded_count: 4,
        excluded_by_reason: {
          already_deterministic: 1,
          not_accepted: 2,
          unsupported_type: 1,
        },
      },
    });
  });

  it("reports mutually exclusive candidate exclusions without sending excluded content", () => {
    const seed = jevNode("requirement_seed");
    const consumer = jevNode("requirement_consumer");
    const input = jevInput([
      seed,
      consumer,
      jevNode("run_deterministic", { type: "Run", status: "proposed" }),
      jevNode("requirement_proposed", { status: "proposed" }),
      jevNode("run_proposed", { type: "Run", status: "proposed" }),
      jevNode("run_accepted", { type: "Run" }),
    ]);
    const mixed = {
      ...input,
      deterministic_entries: [
        ...input.deterministic_entries,
        {
          ...input.deterministic_entries[0]!,
          node_id: "run_deterministic",
          node_type: "Run" as const,
          path: ["edge_seed_run"],
        },
      ],
    };
    const prepared = prepareJevImpactInput(mixed, jevRegistry(), "standard");
    expect(prepared).toMatchObject({
      status: "ready",
      local_diagnostic: {
        code: "candidate_scope",
        candidate_count: 1,
        excluded_count: 5,
        excluded_by_reason: {
          already_deterministic: 2,
          not_accepted: 2,
          unsupported_type: 1,
        },
      },
    });
    const baseline = prepareJevImpactInput(jevInput([seed, consumer]), jevRegistry(), "standard");
    if (prepared.status !== "ready" || baseline.status !== "ready")
      throw new Error("expected ready");
    expect(prepared.request).toEqual(baseline.request);
    expect(prepared.binding).toEqual(baseline.binding);
    expect(
      prepareJevImpactInput(
        { ...mixed, nodes: [...mixed.nodes].reverse() },
        jevRegistry(),
        "standard",
      ),
    ).toEqual(prepared);
    const compile = (ready: typeof prepared) =>
      compilePrompt({
        registry: jevRegistry(),
        selector: { port_id: "impact_advisory", prompt_version: JEV_IMPACT_PROMPT_VERSION },
        profile: "standard",
        input_bundle: buildJevInputBundle(ready.request, ready.binding),
      });
    const compiled = compile(prepared);
    expect(compiled.ok).toBe(true);
    expect(compiled).toEqual(compile(baseline));
  });

  it.each(["Component", "CodeArtifact", "Test"] as const)(
    "rejects unsupported %s projection instead of guessing from scanner metadata",
    (type) => {
      const candidate = jevNode("candidate_01", {
        type,
        extensions: {
          "harness.scan": {
            language: "typescript",
            name: "reportReader",
            hash: "secret-not-business",
          },
        },
      });
      expect(
        prepareJevImpactInput(
          jevInput([jevNode("requirement_seed"), candidate]),
          jevRegistry(),
          "standard",
        ),
      ).toMatchObject({
        status: "failed",
        failure: {
          code: "policy_denied",
          summary: expect.stringContaining("unsupported_projection"),
          retryable: false,
        },
      });
    },
  );

  it("returns all missing business-content questions without using unrelated namespaces or locator", () => {
    const candidates = [
      jevNode("requirement_empty", { extensions: { "harness.requirements": { statement: "  " } } }),
      jevNode("test_ref", {
        type: "Test",
        extensions: { "harness.requirements": { verifies: "requirement_seed" } },
      }),
      jevNode("requirement_other", {
        locator: "repo://project/private.md",
        extensions: { "another.namespace": { statement: "fake title" } },
      }),
    ];
    const result = prepareJevImpactInput(
      jevInput([jevNode("requirement_seed"), ...candidates]),
      jevRegistry(),
      "standard",
    );
    expect(result.status).toBe("clarification_required");
    if (result.status !== "clarification_required") throw new Error("expected clarification");
    expect(result.questions.map((question) => question.target_id).sort()).toEqual([
      "requirement_empty",
      "requirement_other",
      "test_ref",
    ]);
    expect(JSON.stringify(result)).toContain("missing_business_content");
  });

  it("projects approved and legacy business fields by their exact namespace paths", () => {
    const seed = jevNode("intent_seed", {
      type: "Intent",
      extensions: { "harness.requirements": { text: "Change report format" } },
    });
    const nodes = [
      jevNode("requirement_legacy", {
        extensions: {
          "harness.requirements": {
            statement: "Import reports",
            acceptance: [{ description: "Read JSON", verification: "integration-test" }],
          },
        },
      }),
      jevNode("constraint_01", {
        type: "Constraint",
        extensions: {
          "harness.requirements": {
            statement: "Keep backwards compatibility",
            category: "compatibility",
            verification_intent: "test legacy files",
            verification: "manual",
          },
        },
      }),
      jevNode("test_01", {
        protocol_version: "1.1.0",
        type: "Test",
        extensions: {
          "harness.requirements": {
            observable_outcome: "Can import new JSON",
            verification_intent: "integration",
            verifies: "requirement_legacy",
            description: "legacy case",
            verification: "pytest",
          },
        },
      }),
      jevNode("decision_01", {
        type: "Decision",
        extensions: {
          "harness.decision": { summary: "Use versioned exports", private_notes: "not external" },
        },
      }),
    ];
    const result = prepareJevImpactInput(jevInput([seed, ...nodes]), jevRegistry(), "standard");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.request.state.change.fields).toEqual({
      "harness.requirements.text": "Change report format",
    });
    expect(
      result.request.state.candidates.find((node) => node.id === "requirement_legacy")?.fields,
    ).toEqual({
      "harness.requirements.statement": "Import reports",
      "harness.requirements.acceptance[0].description": "Read JSON",
      "harness.requirements.acceptance[0].verification": "integration-test",
    });
    expect(
      result.request.state.candidates.find((node) => node.id === "constraint_01")?.fields,
    ).toEqual({
      "harness.requirements.statement": "Keep backwards compatibility",
      "harness.requirements.category": "compatibility",
      "harness.requirements.verification_intent": "test legacy files",
      "harness.requirements.verification": "manual",
    });
    expect(result.request.state.candidates.find((node) => node.id === "test_01")?.fields).toEqual({
      "harness.requirements.observable_outcome": "Can import new JSON",
      "harness.requirements.verification_intent": "integration",
      "harness.requirements.verifies": "requirement_legacy",
      "harness.requirements.description": "legacy case",
      "harness.requirements.verification": "pytest",
    });
    expect(
      result.request.state.candidates.find((node) => node.id === "decision_01")?.fields,
    ).toEqual({ "harness.decision.summary": "Use versioned exports" });
  });

  it.each([
    [
      "api_contract",
      {
        protocol: "HTTP",
        operations: ["GET /v1/reports"],
        inputs: ["report id"],
        outputs: ["JSON report"],
        errors: ["404"],
        compatibility: "Versioned",
      },
    ],
    [
      "data_contract",
      {
        entities: ["Report"],
        constraints: ["unique id"],
        invariants: ["valid format"],
        migrations: ["CSV to JSON"],
        compatibility: "Readers upgraded",
      },
    ],
    [
      "test_strategy",
      {
        scenarios: ["Import report"],
        test_levels: ["integration"],
        required_gates: ["gate_reports"],
        required_evidence: ["HTTP transcript"],
        tdd: [],
      },
    ],
    [
      "ui_design",
      {
        user_flows: ["View reports"],
        key_states: ["ready"],
        error_states: ["unavailable"],
        accessibility: ["keyboard"],
      },
    ],
  ])(
    "validates and projects 1.1 %s assets without copying non-whitelisted body data",
    (artifactKind, body) => {
      const content = {
        artifact_kind: artifactKind,
        title: "Report contract",
        summary: "Expected report behavior",
        assumptions: ["Consumer has access"],
        acceptance_implications: ["Format must match"],
        body_format: "structured",
        body,
      };
      const node = jevNode("artifact_01", {
        protocol_version: "1.1.0",
        type: "DesignArtifact",
        extensions: { "harness.design.artifact": content },
      });
      const result = prepareJevImpactInput(
        jevInput([jevNode("requirement_seed", { protocol_version: "1.1.0" }), node]),
        jevRegistry(),
        "governed",
      );
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("expected ready");
      const fields = result.request.state.candidates[0]!.fields;
      expect(fields["harness.design.artifact.title"]).toBe("Report contract");
      expect(fields["harness.design.artifact.summary"]).toBe("Expected report behavior");
      expect(fields["harness.design.artifact.assumptions"]).toEqual(["Consumer has access"]);
      for (const [key, value] of Object.entries(body)) {
        if (key === "tdd") expect(fields).not.toHaveProperty("harness.design.artifact.body.tdd");
        else expect(fields[`harness.design.artifact.body.${key}`]).toEqual(value);
      }
      expect(fields).not.toHaveProperty("harness.design.artifact.body_format");
      const invalid = jevNode("artifact_bad", {
        type: "DesignArtifact",
        extensions: { "harness.design.artifact": { ...content, body: { ...body, unknown: "no" } } },
      });
      expect(
        prepareJevImpactInput(
          jevInput([jevNode("requirement_seed"), invalid]),
          jevRegistry(),
          "standard",
        ),
      ).toMatchObject({ status: "failed", failure: { code: "policy_denied" } });
    },
  );

  it("requires business content beyond a DesignArtifact kind and empty or whitespace arrays", () => {
    const content = {
      artifact_kind: "ui_design",
      title: " ",
      summary: " ",
      assumptions: [],
      acceptance_implications: [" "],
      body_format: "structured",
      body: { user_flows: [" "], key_states: [], error_states: [], accessibility: [] },
    };
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-artifact-content", content).valid).toBe(
      true,
    );
    const candidate = jevNode("artifact_empty", {
      protocol_version: "1.1.0",
      type: "DesignArtifact",
      extensions: { "harness.design.artifact": content },
    });
    expect(
      prepareJevImpactInput(
        jevInput([jevNode("requirement_seed"), candidate]),
        jevRegistry(),
        "standard",
      ),
    ).toEqual({
      status: "clarification_required",
      questions: [
        {
          target_id: "artifact_empty",
          question: expect.stringContaining("missing_business_content"),
        },
      ],
    });
  });

  it("allows 20 candidates and rejects 21 without truncating", () => {
    const nodes = Array.from({ length: 20 }, (_, index) => jevNode(`requirement_${index}`));
    const result = prepareJevImpactInput(
      jevInput([jevNode("requirement_seed"), ...nodes]),
      jevRegistry(),
      "standard",
    );
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.request.state.candidates).toHaveLength(20);
    expect(() =>
      prepareJevImpactInput(
        jevInput([jevNode("requirement_seed"), ...nodes, jevNode("requirement_extra")]),
        jevRegistry(),
        "standard",
      ),
    ).toThrow(PromptPreparationFailureError);
  });

  it("enforces the exact 16 KiB canonical UTF-8 state boundary including Chinese", () => {
    const withText = (text: string) =>
      jevInput([
        jevNode("requirement_seed"),
        jevNode("requirement_consumer", {
          extensions: { "harness.requirements": { statement: text } },
        }),
      ]);
    const base = prepareJevImpactInput(withText("中"), jevRegistry(), "standard");
    if (base.status !== "ready") throw new Error("expected base ready");
    const remaining = 16_384 - Buffer.byteLength(canonicalizeJson(base.request.state), "utf8");
    expect(
      prepareJevImpactInput(withText("中" + "x".repeat(remaining)), jevRegistry(), "standard")
        .status,
    ).toBe("ready");
    expect(() =>
      prepareJevImpactInput(withText("中" + "x".repeat(remaining + 1)), jevRegistry(), "standard"),
    ).toThrow(PromptPreparationFailureError);
  });

  it.each(["lite", "standard", "governed"] as const)(
    "compiles 20 candidates with long IDs and a 16 KiB state under the existing source boundary: %s",
    (profile) => {
      const nodes = Array.from({ length: 20 }, (_, index) =>
        jevNode("requirement_" + String(index).padStart(3, "0") + "x".repeat(145)),
      );
      const source = jevInput([jevNode("requirement_seed"), ...nodes]);
      const base = prepareJevImpactInput(source, jevRegistry(), profile);
      if (base.status !== "ready") throw new Error("expected base ready");
      const padding = 16_384 - Buffer.byteLength(canonicalizeJson(base.request.state), "utf8");
      const first = nodes[0]!;
      const padded = jevNode(first.id, {
        extensions: {
          "harness.requirements": {
            statement: "Read exported reports as CSV" + "x".repeat(padding),
          },
        },
      });
      const result = prepareJevImpactInput(
        { ...source, nodes: [source.nodes[0]!, padded, ...nodes.slice(1)] },
        jevRegistry(),
        profile,
      );
      if (result.status !== "ready") throw new Error("expected boundary ready");
      expect(Buffer.byteLength(canonicalizeJson(result.request.state), "utf8")).toBe(16_384);
      expect(
        compilePrompt({
          registry: jevRegistry(),
          selector: { port_id: "impact_advisory", prompt_version: "impact_advisory.jev.v1" },
          profile,
          input_bundle: buildJevInputBundle(result.request, result.binding),
        }).ok,
      ).toBe(true);
    },
  );

  it.each([
    "apikey_" + "a".repeat(32) + "_" + "b".repeat(64),
    ["/", "Users", "/alice/config"].join(""),
    "</untrusted-input>",
  ])("rejects unsafe projected source content: %#", (text) => {
    expect(() =>
      prepareJevImpactInput(
        jevInput([
          jevNode("requirement_seed"),
          jevNode("requirement_consumer", {
            extensions: { "harness.requirements": { statement: text } },
          }),
        ]),
        jevRegistry(),
        "standard",
      ),
    ).toThrow(PromptPreparationFailureError);
  });

  it.each(["scalar", "array"])(
    "rejects a raw Windows user path before JSON escaping in a %s field",
    (kind) => {
      const path = ["C:", "Users", "fixture-user", ".config", "private.json"].join("\\");
      const candidate =
        kind === "scalar"
          ? jevNode("candidate_01", { extensions: { "harness.requirements": { statement: path } } })
          : jevNode("candidate_01", {
              protocol_version: "1.1.0",
              type: "DesignArtifact",
              extensions: {
                "harness.design.artifact": {
                  artifact_kind: "ui_design",
                  title: "Report page",
                  summary: "View reports",
                  assumptions: [path],
                  acceptance_implications: [],
                  body_format: "structured",
                  body: {
                    user_flows: ["View reports"],
                    key_states: [],
                    error_states: [],
                    accessibility: [],
                  },
                },
              },
            });
      expect(() =>
        prepareJevImpactInput(
          jevInput([jevNode("requirement_seed"), candidate]),
          jevRegistry(),
          "standard",
        ),
      ).toThrowError(
        expect.objectContaining({
          name: "PromptPreparationFailureError",
          failure: expect.objectContaining({
            code: "untrusted_source_boundary_failed",
            retryable: false,
            summary: expect.not.stringContaining(path),
          }),
        }),
      );
    },
  );

  it("canonicalizes candidate order and includes every authority/profile/policy segment in real instructions", () => {
    const input = jevInput([
      jevNode("requirement_seed"),
      jevNode("requirement_z"),
      jevNode("requirement_a"),
    ]);
    const first = prepareJevImpactInput(input, jevRegistry(), "governed");
    expect(
      prepareJevImpactInput(
        { ...input, nodes: [...input.nodes].reverse() },
        jevRegistry(),
        "governed",
      ),
    ).toEqual(first);
    if (first.status !== "ready") throw new Error("expected ready");
    const instruction = first.request.questions["requirement_a"]!.instructions;
    const contract = JEV_IMPACT_PROMPT_REGISTRATION.contract;
    expect(instruction).toContain(contract.authority_boundary.text);
    expect(instruction).toContain(contract.role_instruction.text);
    expect(instruction).toContain(contract.profile_overlays.governed.text);
    expect(instruction).toContain("state.candidates[0]");
    expect(instruction).not.toContain("{index}");
  });

  it("projects grounded business content without actor metadata and explicitly addresses the candidate", () => {
    const seed = businessNode("requirement_01", "Change the report export contract");
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
      nodes: [candidate, seed],
      requirement_digests: { [seed.id]: seed.digest },
      rule_registry_version: RELATION_RULE_REGISTRY.version,
      rule_registry_digest: RELATION_RULE_REGISTRY.digest,
      conversation_id: "conversation_01",
      run_id: "run_01",
    };

    const prepared = prepareJevImpactInput(
      input,
      createPromptContractRegistry([JEV_IMPACT_PROMPT_REGISTRATION]),
      "standard",
    );

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected ready fixture");
    expect(prepared.request.state).toEqual({
      change: {
        id: seed.id,
        type: "Requirement",
        revision: 1,
        digest: seed.digest,
        fields: { "harness.requirements.statement": "Change the report export contract" },
      },
      candidates: [
        {
          id: candidate.id,
          type: "Requirement",
          revision: 1,
          digest: candidate.digest,
          fields: { "harness.requirements.statement": "Consume that exported report" },
        },
      ],
    });
    expect(prepared.request.questions[candidate.id]?.instructions).toContain("state.candidates[0]");
    expect(prepared.request.questions[candidate.id]?.instructions).toContain("state.change");
    expect(JSON.stringify(prepared.request.state)).not.toContain('"actor"');
  });
});
