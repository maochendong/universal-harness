import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

import { SCHEMA_EXPORT_DOCUMENTS } from "../dist/schema/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = join(packageRoot, "schemas");
mkdirSync(schemaDirectory, { recursive: true });

for (const [name, schema] of Object.entries(SCHEMA_EXPORT_DOCUMENTS)) {
  const filepath = join(schemaDirectory, name);
  // The Prettier API does not load .prettierrc by itself; without the repo
  // config the emitted text drifts from what `prettier --check` enforces.
  const config = (await resolveConfig(filepath)) ?? {};
  const serialized = await format(JSON.stringify(schema), { ...config, filepath });
  writeFileSync(filepath, serialized);
}

console.log(`Generated ${Object.keys(SCHEMA_EXPORT_DOCUMENTS).length} JSON Schema documents.`);
