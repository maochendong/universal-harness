import { describe, expect, it } from "vitest";

import { ToolError } from "../../src/tools/definition.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { okHandler, pureTool } from "./fixtures.js";

/**
 * Tool Registry (design 13.5; ToolRegistryPort in design 18): versioned,
 * immutable descriptors, deterministic version resolution, and a per-run
 * invocation quota.
 */
describe("ToolRegistry", () => {
  it("registers and resolves the highest version by default", () => {
    const registry = new ToolRegistry();
    registry.register(pureTool({ version: "1.0.0" }), okHandler());
    registry.register(pureTool({ version: "1.2.0" }), okHandler());
    registry.register(pureTool({ version: "0.9.0" }), okHandler());
    expect(registry.get("http_fetch")?.definition.version).toBe("1.2.0");
    expect(registry.get("http_fetch", "0.9.0")?.definition.version).toBe("0.9.0");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("lists descriptors in deterministic name/version order", () => {
    const registry = new ToolRegistry();
    registry.register(pureTool({ name: "zeta", version: "1.0.0" }), okHandler());
    registry.register(pureTool({ name: "alpha", version: "2.0.0" }), okHandler());
    registry.register(pureTool({ name: "alpha", version: "1.0.0" }), okHandler());
    expect(registry.list().map((tool) => `${tool.name}@${tool.version}`)).toEqual([
      "alpha@1.0.0",
      "alpha@2.0.0",
      "zeta@1.0.0",
    ]);
  });

  it("treats identical re-registration as idempotent but refuses changed content", () => {
    const registry = new ToolRegistry();
    const first = registry.register(pureTool(), okHandler());
    const second = registry.register(pureTool(), okHandler());
    expect(second.digest).toBe(first.digest);
    expect(() => registry.register(pureTool({ description: "changed" }), okHandler())).toThrowError(
      ToolError,
    );
    expect(registry.get("http_fetch")?.definition.description).toBe("fetch a URL");
  });

  it("refuses descriptors whose schemas do not compile", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register(pureTool({ input_schema: { type: "not-a-type" } }), okHandler()),
    ).toThrowError(ToolError);
    expect(registry.get("http_fetch")).toBeUndefined();
  });

  it("tracks quota per tool version and reports invocation summaries", () => {
    const registry = new ToolRegistry();
    const definition = registry.register(pureTool({ max_invocations_per_run: 2 }), okHandler());
    expect(registry.quotaRemaining(definition)).toBe(2);
    registry.consumeQuota(definition);
    registry.consumeQuota(definition);
    expect(registry.quotaRemaining(definition)).toBe(0);
    expect(() => registry.consumeQuota(definition)).toThrowError(ToolError);
    expect(registry.invocationSummaries()).toEqual([
      { tool: "http_fetch", version: "1.0.0", invocations: 2, quota: 2 },
    ]);
  });
});
