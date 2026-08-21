import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROFILE_IDS } from "@universal-harness-internal/core";
import { compilePrompt } from "@universal-harness-internal/runtime";

import {
  SHIPPED_PROMPT_CONTRACT_REGISTRATIONS,
  createShippedPromptContractRegistry,
} from "../src/prompt-registry.js";

/**
 * PG-9 golden matrix (plan T19): all eleven shipped contracts compile
 * across all three profiles with digests pinned to the committed golden.
 * Any contract, overlay, schema or compiler drift fails this test; a new
 * contract without a golden regeneration fails it too.
 */
const goldenPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/golden/prompt-contracts/compiled-matrix.json",
);

const INPUT_BUNDLE = {
  bundle_id: "golden_bundle",
  items: [{ source_id: "golden", source_kind: "golden", text: "golden input" }],
};

function computeMatrix() {
  const registry = createShippedPromptContractRegistry();
  const rows = [];
  for (const registration of SHIPPED_PROMPT_CONTRACT_REGISTRATIONS) {
    for (const promptVersion of registration.prompt_versions) {
      for (const profile of PROFILE_IDS) {
        const selector = {
          port_id: registration.contract.port_id,
          prompt_version: promptVersion,
          ...(registration.contract.purpose === undefined
            ? {}
            : { purpose: registration.contract.purpose }),
        };
        const result = compilePrompt({ registry, selector, profile, input_bundle: INPUT_BUNDLE });
        if (!result.ok) throw new Error(result.failure.summary);
        rows.push({
          contract_id: registration.contract.contract_id,
          prompt_version: promptVersion,
          profile,
          contract_digest: result.compiled.contract_digest,
          profile_overlay_digest: result.compiled.profile_overlay_digest,
          output_schema_digest: result.compiled.output_schema_digest,
          input_bundle_digest: result.compiled.input_bundle_digest,
          compiled_prompt_digest: result.compiled.compiled_prompt_digest,
        });
      }
    }
  }
  return rows.sort((left, right) =>
    `${left.contract_id}${left.prompt_version}${left.profile}`.localeCompare(
      `${right.contract_id}${right.prompt_version}${right.profile}`,
    ),
  );
}

describe("prompt contract golden matrix", () => {
  it("matches the committed golden for every contract and profile", () => {
    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as unknown;
    expect(computeMatrix()).toEqual(golden);
  });

  it("keeps profile overlays distinct and compilation deterministic", () => {
    const matrix = computeMatrix();
    expect(matrix).toHaveLength(33);
    for (const registration of SHIPPED_PROMPT_CONTRACT_REGISTRATIONS) {
      const rows = matrix.filter((row) => row.contract_id === registration.contract.contract_id);
      const overlays = new Set(rows.map((row) => row.profile_overlay_digest));
      expect(overlays.size).toBe(3);
      const compiled = new Set(rows.map((row) => row.compiled_prompt_digest));
      expect(compiled.size).toBe(3);
    }
    expect(computeMatrix()).toEqual(matrix);
  });
});
