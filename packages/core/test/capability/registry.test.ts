import { describe, expect, it } from "vitest";

import {
  CAPABILITY_MODULE_DEFINITIONS,
  CapabilityRegistryError,
  capabilityDependencyClosure,
  capabilityModuleDefinition,
  dependencyClosure,
  verifyModuleDefinitionDigests,
  type CapabilityModuleDefinition,
} from "../../src/capability/registry.js";
import { CAPABILITY_IDS, type CapabilityId } from "../../src/schema/profile.js";

function definition(capabilityId: CapabilityId): CapabilityModuleDefinition {
  return capabilityModuleDefinition(capabilityId);
}

describe("capability module registry", () => {
  it("registers exactly the five built-in protocol 1.1 modules", () => {
    expect(CAPABILITY_MODULE_DEFINITIONS.map((module) => module.capability_id).sort()).toEqual(
      [...CAPABILITY_IDS].sort(),
    );
  });

  it("seals every definition with a stable definition digest", () => {
    for (const module of CAPABILITY_MODULE_DEFINITIONS) {
      expect(module.definition_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(module.version).toMatch(/^\d+\.\d+\.\d+$/u);
    }
    expect(verifyModuleDefinitionDigests()).toBe(true);
  });

  it("fails closed on unknown capability ids", () => {
    expect(() => capabilityModuleDefinition("quantum_review")).toThrow(CapabilityRegistryError);
    expect(() => capabilityDependencyClosure(["quantum_review"])).toThrow(CapabilityRegistryError);
  });

  it("declares the protocol dependency edges", () => {
    expect(definition("design_governance").depends_on).toEqual(["impact_analysis"]);
    expect(definition("strict_tdd").depends_on).toEqual(["design_governance"]);
    expect(definition("impact_analysis").depends_on).toEqual([]);
    expect(definition("independent_evaluation").depends_on).toEqual([]);
    expect(definition("advanced_audit").depends_on).toEqual([]);
  });

  it("requires structured gate and isolated workspace providers for strict_tdd only", () => {
    expect([...definition("strict_tdd").required_providers].sort()).toEqual([
      "isolated_workspace_provider",
      "structured_gate_provider",
    ]);
    for (const capabilityId of CAPABILITY_IDS) {
      if (capabilityId === "strict_tdd") continue;
      expect(definition(capabilityId).required_providers).toEqual([]);
    }
  });

  it("keeps module output bindings disjoint so no two modules own the same artifact", () => {
    const outputs = CAPABILITY_MODULE_DEFINITIONS.flatMap((module) => module.output_bindings);
    expect(new Set(outputs).size).toBe(outputs.length);
  });
});

describe("capability dependency closure", () => {
  it("returns the empty closure for no capabilities", () => {
    expect(capabilityDependencyClosure([])).toEqual([]);
  });

  it("adds impact_analysis and design_governance behind strict_tdd", () => {
    expect(capabilityDependencyClosure(["strict_tdd"])).toEqual([
      "design_governance",
      "impact_analysis",
      "strict_tdd",
    ]);
  });

  it("adds impact_analysis behind design_governance", () => {
    expect(capabilityDependencyClosure(["design_governance"])).toEqual([
      "design_governance",
      "impact_analysis",
    ]);
  });

  it("leaves kernel-attached modules without extra dependencies", () => {
    expect(capabilityDependencyClosure(["impact_analysis"])).toEqual(["impact_analysis"]);
    expect(capabilityDependencyClosure(["independent_evaluation"])).toEqual([
      "independent_evaluation",
    ]);
    expect(capabilityDependencyClosure(["advanced_audit"])).toEqual(["advanced_audit"]);
  });

  it("closes the full set to itself in canonical order", () => {
    expect(capabilityDependencyClosure([...CAPABILITY_IDS])).toEqual([...CAPABILITY_IDS].sort());
  });

  it("detects dependency cycles in module graphs", () => {
    const cyclic: CapabilityModuleDefinition[] = [
      { ...definition("impact_analysis"), depends_on: ["design_governance"] },
      definition("design_governance"),
      definition("independent_evaluation"),
      definition("strict_tdd"),
      definition("advanced_audit"),
    ];
    expect(() => dependencyClosure(cyclic, ["impact_analysis"])).toThrow(CapabilityRegistryError);
    try {
      dependencyClosure(cyclic, ["impact_analysis"]);
      expect.unreachable("a cycle must throw");
    } catch (error) {
      expect((error as CapabilityRegistryError).reason).toContain("cycle");
    }
  });

  it("detects unknown dependencies in module graphs", () => {
    const dangling: CapabilityModuleDefinition[] = [
      { ...definition("advanced_audit"), depends_on: ["strict_tdd"] },
    ];
    expect(() => dependencyClosure(dangling, ["advanced_audit"])).toThrow(CapabilityRegistryError);
  });
});
