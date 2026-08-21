/**
 * PG-9 golden generator (plan T19): compiles every shipped prompt contract
 * across the three profiles with a fixed input bundle and pins the digests
 * as the golden matrix; also pins the versioned relation rule registry.
 * Run after `pnpm build` whenever a contract or relation rule legitimately
 * changes, then review the diff like any other semantic change.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createShippedPromptContractRegistry,
  SHIPPED_PROMPT_CONTRACT_REGISTRATIONS,
} from "../packages/cli/dist/prompt-registry.js";
import { compilePrompt } from "../packages/runtime/dist/model/prompt-compiler.js";
import {
  RELATION_COMPATIBILITY,
  RELATION_RULE_REGISTRY,
  PROPAGATION_RULES,
} from "../packages/graph/dist/index.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const PROFILES = ["lite", "standard", "governed"];
const INPUT_BUNDLE = {
  bundle_id: "golden_bundle",
  items: [{ source_id: "golden", source_kind: "golden", text: "golden input" }],
};

const registry = createShippedPromptContractRegistry();
const matrix = [];
for (const registration of SHIPPED_PROMPT_CONTRACT_REGISTRATIONS) {
  for (const promptVersion of registration.prompt_versions) {
    for (const profile of PROFILES) {
      const selector = {
        port_id: registration.contract.port_id,
        prompt_version: promptVersion,
        ...(registration.contract.purpose === undefined
          ? {}
          : { purpose: registration.contract.purpose }),
      };
      const result = compilePrompt({ registry, selector, profile, input_bundle: INPUT_BUNDLE });
      if (!result.ok) {
        throw new Error(
          `golden compile failed for ${registration.contract.contract_id}/${promptVersion}/${profile}: ${result.failure.summary}`,
        );
      }
      matrix.push({
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
matrix.sort((left, right) =>
  `${left.contract_id}${left.prompt_version}${left.profile}`.localeCompare(
    `${right.contract_id}${right.prompt_version}${right.profile}`,
  ),
);

const promptGoldenPath = join(repositoryRoot, "tests/golden/prompt-contracts/compiled-matrix.json");
mkdirSync(dirname(promptGoldenPath), { recursive: true });
writeFileSync(promptGoldenPath, `${JSON.stringify(matrix, null, 2)}\n`);

const relationGolden = {
  registry_version: RELATION_RULE_REGISTRY.version,
  registry_digest: RELATION_RULE_REGISTRY.digest,
  compatibility_rules: RELATION_COMPATIBILITY,
  propagation_rules: PROPAGATION_RULES,
};
const relationGoldenPath = join(repositoryRoot, "tests/golden/relation-rules/registry.json");
mkdirSync(dirname(relationGoldenPath), { recursive: true });
writeFileSync(relationGoldenPath, `${JSON.stringify(relationGolden, null, 2)}\n`);

console.log(
  `wrote ${matrix.length} compiled contract rows and ${relationGolden.compatibility_rules.length} relation rules`,
);
