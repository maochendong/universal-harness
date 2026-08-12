import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import { JSON_SCHEMA_DOCUMENTS } from "../dist/schema/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = join(packageRoot, "schemas");
mkdirSync(schemaDirectory, { recursive: true });

for (const [name, schema] of Object.entries(JSON_SCHEMA_DOCUMENTS)) {
  const serialized = await format(JSON.stringify(schema), {
    filepath: join(schemaDirectory, name),
  });
  writeFileSync(join(schemaDirectory, name), serialized);
}

console.log(`Generated ${Object.keys(JSON_SCHEMA_DOCUMENTS).length} JSON Schema documents.`);
