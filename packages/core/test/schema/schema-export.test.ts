import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { JSON_SCHEMA_DOCUMENTS } from "../../src/schema/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("generated JSON Schema", () => {
  it("matches the committed JSON Schema 2020-12 documents", () => {
    const schemaDirectory = join(packageRoot, "schemas");
    const files = readdirSync(schemaDirectory).filter((name) => name.endsWith(".schema.json"));
    expect(files.sort()).toEqual(Object.keys(JSON_SCHEMA_DOCUMENTS).sort());

    for (const [name, schema] of Object.entries(JSON_SCHEMA_DOCUMENTS)) {
      expect(JSON.parse(readFileSync(join(schemaDirectory, name), "utf8")), name).toEqual(schema);
      expect(schema).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema" });
    }
  });
});
