import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SCENARIOS, scenarioByName, summarizeReport } from "./scenarios.js";

const goldenDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/golden/evaluations",
);

function readGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as unknown;
}

/** Golden evaluation reports (plan Task 20): fixed inputs, stable reports. */
describe("evaluation goldens", () => {
  it.each(SCENARIOS.map((scenario) => scenario.name))("pins the %s report golden", (name) => {
    expect(summarizeReport(scenarioByName(name))).toEqual(readGolden(`${name}.json`));
  });
});
