import { describe, expect, it } from "vitest";

import { validateSchema } from "@universal-harness-internal/core";

import { compileContextBundle, type CompileContextInput } from "../../src/context/compiler.js";
import { TRUNCATE_COMPRESSOR_ID, type Compressor } from "../../src/context/compression.js";
import { ContextError } from "../../src/context/selector.js";

import { BINDINGS, candidate } from "./fixtures.js";

function input(overrides?: Partial<CompileContextInput>): CompileContextInput {
  return {
    taskId: "task_01",
    goal: "ship the health endpoint",
    bindings: BINDINGS,
    tokenBudget: 4000,
    candidates: [candidate("requirement_01", "Requirement", 1, "the goal stays fixed")],
    ...overrides,
  };
}

describe("compileContextBundle", () => {
  it("assembles sources in tier order with full per-source traceability", () => {
    const compiled = compileContextBundle(
      input({
        candidates: [
          candidate("code_01", "CodeArtifact", 3, "export function health() {}"),
          candidate("requirement_01", "Requirement", 1, "provide a health endpoint"),
          candidate("decision_01", "Decision", 3, "use the existing router"),
          candidate("finding_01", "Finding", 4, "router drops unknown verbs"),
        ],
      }),
    );
    const { manifest, record } = compiled;
    expect(manifest.entries.map((entry) => entry.node_id)).toEqual([
      "requirement_01",
      "code_01",
      "decision_01",
      "finding_01",
    ]);
    const requirement = manifest.entries[0];
    expect(requirement).toMatchObject({
      node_id: "requirement_01",
      revision: 1,
      knowledge_layer: "none",
      reason: "reason for requirement_01",
      priority: 1,
      freshness: "fresh",
      compression: "none",
      sensitive: false,
    });
    expect(requirement?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.entries[2]?.knowledge_layer).toBe("L2");
    expect(manifest.entries[3]?.knowledge_layer).toBe("L5");
    expect(manifest.exclusions).toEqual([]);
    expect(record.record_kind).toBe("context_bundle");
    expect(record.task_id).toBe("task_01");
    expect(record.digest).toBe(manifest.content_digest);
    expect(record.stale).toBe(false);
    expect(record.source_digests).toEqual(
      [...new Set(manifest.entries.map((entry) => entry.digest))].sort(),
    );
    expect(validateSchema("runtime", record).valid).toBe(true);
  });

  it("reproduces the exact same manifest, digest and record for the same inputs", () => {
    const spec = input({
      candidates: [
        candidate("requirement_01", "Requirement", 1, "provide a health endpoint"),
        candidate("code_01", "CodeArtifact", 3, "export function health() {}"),
      ],
    });
    const first = compileContextBundle(spec);
    const second = compileContextBundle(spec);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.record).toEqual(first.record);
    expect(second.assembled).toBe(first.assembled);
  });

  it("never compresses protected content away, even past the tier budget", () => {
    const filler = Array.from({ length: 40 }, (_, index) => `filler line ${index}`).join("\n");
    const goal = "the goal stays fixed at all times"; // 9 tokens, over the tier 1 share of 20
    const content = `${goal}\n${filler}`;
    const compiled = compileContextBundle(
      input({
        tokenBudget: 20,
        candidates: [
          candidate("requirement_01", "Requirement", 1, content, {
            protectedFields: [goal],
          }),
        ],
      }),
    );
    const entry = compiled.manifest.entries[0];
    expect(entry?.compression).toBe(TRUNCATE_COMPRESSOR_ID);
    expect(entry?.included_tokens).toBeGreaterThan(6); // tier 1 allocation of 20
    expect(compiled.assembled).toContain(goal);
    expect(compiled.assembled).not.toContain("filler line 39");
    expect(entry?.original_tokens).toBeGreaterThan(entry?.included_tokens ?? 0);
  });

  it("records caller exclusions, duplicates and budget exhaustion with reasons", () => {
    const big = "x".repeat(400);
    const code = Array.from({ length: 50 }, (_, index) => `code line ${index}`).join("\n");
    const compiled = compileContextBundle(
      input({
        tokenBudget: 40,
        candidates: [
          candidate("requirement_01", "Requirement", 1, "goal"),
          candidate("code_01", "CodeArtifact", 3, code),
          candidate("code_01", "CodeArtifact", 4, code),
          candidate("decision_01", "Decision", 4, "use the existing router"),
          candidate("finding_01", "Finding", 5, big),
        ],
        exclusions: [{ nodeId: "decision_01", reason: "policy_exclusion" }],
      }),
    );
    const byId = new Map(
      compiled.manifest.exclusions.map((exclusion) => [exclusion.node_id, exclusion.reason]),
    );
    expect(byId.get("decision_01")).toBe("policy_exclusion");
    expect(byId.get("code_01")).toBe("duplicate_source");
    // Tier 5 gets 10 percent of 40 tokens; the 400 character finding cannot fit.
    expect(byId.get("finding_01")).toBe("budget_exhausted");
    expect(compiled.manifest.entries.map((entry) => entry.node_id)).toEqual([
      "requirement_01",
      "code_01",
    ]);
    // The tier 3 share is 8 tokens: only a prefix of the code lines fits.
    const codeEntry = compiled.manifest.entries.find((entry) => entry.node_id === "code_01");
    expect(codeEntry?.compression).toBe(TRUNCATE_COMPRESSOR_ID);
    expect(codeEntry?.included_tokens).toBeLessThanOrEqual(8);
  });

  it("keeps sensitive source content local while the manifest carries only references", () => {
    const secret = "internal customer list: acme, initech";
    const compiled = compileContextBundle(
      input({
        candidates: [
          candidate("requirement_01", "Requirement", 1, "goal"),
          candidate("code_01", "CodeArtifact", 3, secret, { sensitive: true }),
        ],
      }),
    );
    const entry = compiled.manifest.entries.find((item) => item.node_id === "code_01");
    expect(entry?.sensitive).toBe(true);
    // The local assembled context keeps the raw text; the committable
    // manifest and record only carry reference, digest and sizes.
    expect(compiled.assembled).toContain(secret);
    expect(JSON.stringify(compiled.manifest)).not.toContain(secret);
    expect(JSON.stringify(compiled.record)).not.toContain(secret);
  });

  it("freezes the manifest and the record", () => {
    const compiled = compileContextBundle(input());
    expect(Object.isFrozen(compiled.manifest)).toBe(true);
    expect(Object.isFrozen(compiled.manifest.entries)).toBe(true);
    expect(Object.isFrozen(compiled.record)).toBe(true);
    expect(() => {
      (compiled.manifest as { token_budget: number }).token_budget = 1;
    }).toThrowError(TypeError);
  });

  it("compiles adjacent DAG tasks into independent bundles", () => {
    const candidates = [
      candidate("requirement_01", "Requirement", 1, "goal"),
      candidate("code_01", "CodeArtifact", 3, "export function health() {}"),
    ];
    const first = compileContextBundle(input({ taskId: "task_01", candidates }));
    const second = compileContextBundle(input({ taskId: "task_02", candidates }));
    expect(first.manifest.content_digest).not.toBe(second.manifest.content_digest);
    expect(first.record.context_bundle_id).not.toBe(second.record.context_bundle_id);
    expect(first.manifest.task_id).toBe("task_01");
    expect(second.manifest.task_id).toBe("task_02");
    expect(first.manifest.entries).not.toBe(second.manifest.entries);
  });

  it("honors a pluggable compressor", () => {
    const redacting: Compressor = {
      id: "redact-v1",
      compress: (content) => ({
        content: content.replaceAll("secret", "[redacted]"),
        method: "redact-v1",
        originalTokens: 1,
        includedTokens: 1,
      }),
    };
    const compiled = compileContextBundle(
      input({
        compressor: redacting,
        candidates: [candidate("code_01", "CodeArtifact", 3, "a secret value")],
      }),
    );
    expect(compiled.manifest.entries[0]?.compression).toBe("redact-v1");
    expect(compiled.assembled).toContain("[redacted]");
    expect(compiled.assembled).not.toContain("secret value");
  });

  it("rejects invalid budgets, missing protected fields, empty sources and bad ids", () => {
    expect(() => compileContextBundle(input({ tokenBudget: 0 }))).toThrowError(ContextError);
    expect(() => compileContextBundle(input({ tokenBudget: 2.5 }))).toThrowError(
      /positive integer/,
    );
    expect(() =>
      compileContextBundle(
        input({
          candidates: [
            candidate("requirement_01", "Requirement", 1, "goal", {
              protectedFields: ["not in the content"],
            }),
          ],
        }),
      ),
    ).toThrowError(/verbatim span/);
    expect(() => compileContextBundle(input({ candidates: [] }))).toThrowError(
      /at least one source/,
    );
    expect(() => compileContextBundle(input({ taskId: "Task One" }))).toThrowError(
      /invalid context bundle record/,
    );
  });
});
