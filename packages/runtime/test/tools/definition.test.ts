import { describe, expect, it } from "vitest";

import {
  ToolError,
  compareToolVersions,
  normalizeToolDefinition,
  resourceMatchesPatterns,
} from "../../src/tools/definition.js";
import { pureTool } from "./fixtures.js";

/**
 * Tool Descriptor normalization (design 13.5): every capability is described
 * by a stable name, version, schemas, phase/resource scope, risk, side-effect
 * class, approval, redaction, timeout, retry, quota and reconciliation
 * declaration. Structurally illegal descriptors are refused before they can
 * ever be registered or invoked.
 */
describe("normalizeToolDefinition", () => {
  it("normalizes a valid descriptor with a stable digest", () => {
    const first = normalizeToolDefinition(pureTool());
    const second = normalizeToolDefinition(pureTool());
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.digest).toBe(second.digest);
    expect(first.allowed_phases).toEqual(["implementation"]);
    expect(first.retry_class).toBe("none");
  });

  it("rejects illegal names and versions", () => {
    expect(() => normalizeToolDefinition(pureTool({ name: "Http Fetch" }))).toThrowError(ToolError);
    expect(() => normalizeToolDefinition(pureTool({ name: "-bad" }))).toThrowError(ToolError);
    expect(() => normalizeToolDefinition(pureTool({ version: "1.0" }))).toThrowError(ToolError);
    expect(() => normalizeToolDefinition(pureTool({ version: "soon" }))).toThrowError(ToolError);
  });

  it("rejects non-object schemas and empty phase lists", () => {
    expect(() => normalizeToolDefinition(pureTool({ input_schema: "string" }))).toThrowError(
      ToolError,
    );
    expect(() => normalizeToolDefinition(pureTool({ allowed_phases: [] }))).toThrowError(ToolError);
    expect(() => normalizeToolDefinition(pureTool({ timeout_ms: 0 }))).toThrowError(ToolError);
    expect(() => normalizeToolDefinition(pureTool({ max_invocations_per_run: 0 }))).toThrowError(
      ToolError,
    );
  });

  it("rejects contradictory retry declarations", () => {
    expect(() =>
      normalizeToolDefinition(pureTool({ retry_class: "none", max_retries: 1 })),
    ).toThrowError(ToolError);
    expect(() =>
      normalizeToolDefinition(
        pureTool({ retry_class: "idempotent_only", max_retries: 1, idempotent: false }),
      ),
    ).toThrowError(ToolError);
  });

  it("rejects undeclared enum values and illegal secret parameter names", () => {
    expect(() => normalizeToolDefinition(pureTool({ risk: "extreme" }))).toThrowError(ToolError);
    expect(() =>
      normalizeToolDefinition(pureTool({ side_effect_class: "everywhere" })),
    ).toThrowError(ToolError);
    expect(() =>
      normalizeToolDefinition(pureTool({ secret_parameters: ["not a name"] })),
    ).toThrowError(ToolError);
  });

  it("rejects malformed parameter bounds", () => {
    expect(() =>
      normalizeToolDefinition(pureTool({ parameter_bounds: { mode: [] } })),
    ).toThrowError(ToolError);
    expect(() =>
      normalizeToolDefinition(pureTool({ parameter_bounds: { mode: [{ nested: true }] } })),
    ).toThrowError(ToolError);
  });
});

describe("resourceMatchesPatterns", () => {
  it("matches exact and prefix patterns", () => {
    expect(resourceMatchesPatterns(["issue:42"], "issue:42")).toBe(true);
    expect(resourceMatchesPatterns(["issue:*"], "issue:42")).toBe(true);
    expect(resourceMatchesPatterns(["issue:*"], "pull:42")).toBe(false);
    expect(resourceMatchesPatterns([], "anything")).toBe(false);
  });
});

describe("compareToolVersions", () => {
  it("orders semver triples numerically", () => {
    const ordered = ["10.0.0", "2.0.0", "1.2.0", "1.10.0"].sort(compareToolVersions);
    expect(ordered).toEqual(["1.2.0", "1.10.0", "2.0.0", "10.0.0"]);
  });
});
