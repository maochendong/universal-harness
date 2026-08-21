import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contentDigest } from "@universal-harness-internal/core";

import { RELATION_COMPATIBILITY, isRelationCompatible } from "../../src/integrity.js";
import { PROPAGATION_RULES } from "../../src/impact/propagation.js";
import { RELATION_RULE_REGISTRY } from "../../src/impact/advisory.js";

/**
 * PG-9/T19 relation rule golden: the versioned registry, the compatibility
 * table and the propagation policy pin to the committed golden. A new or
 * changed relation without a deliberate golden regeneration fails here,
 * and the registry digest always matches the shipped table.
 */
const goldenPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tests/golden/relation-rules/registry.json",
);

describe("relation rule registry golden", () => {
  it("matches the committed golden exactly", () => {
    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
      registry_version: string;
      registry_digest: string;
      compatibility_rules: unknown;
      propagation_rules: unknown;
    };
    expect(RELATION_RULE_REGISTRY.version).toBe(golden.registry_version);
    expect(RELATION_RULE_REGISTRY.digest).toBe(golden.registry_digest);
    expect(RELATION_RULE_REGISTRY.digest).toBe(contentDigest(RELATION_COMPATIBILITY));
    expect(RELATION_COMPATIBILITY).toEqual(golden.compatibility_rules);
    expect(PROPAGATION_RULES).toEqual(golden.propagation_rules);
  });

  it("admits the SPECIFIES triples and nothing beyond the table", () => {
    for (const target of ["Requirement", "Decision", "Component", "Test"] as const) {
      expect(isRelationCompatible("SPECIFIES", "DesignArtifact", target)).toBe(true);
    }
    expect(isRelationCompatible("SPECIFIES", "Decision", "Requirement")).toBe(false);
    expect(isRelationCompatible("SPECIFIES", "DesignArtifact", "ImpactSet")).toBe(false);
  });
});
