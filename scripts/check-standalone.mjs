import { readFileSync } from "node:fs";
import { join } from "node:path";

import { scanStandaloneRepository } from "./standalone-scan.mjs";

const cwd = process.cwd();
const exceptionDocument = JSON.parse(
  readFileSync(join(cwd, "scripts", "standalone-history-exceptions.json"), "utf8"),
);
if (
  exceptionDocument.schema_version !== "standalone-history-exceptions.v1" ||
  !Array.isArray(exceptionDocument.exceptions)
) {
  throw new Error("invalid standalone history exception document");
}

const findings = scanStandaloneRepository({
  cwd,
  exceptions: exceptionDocument.exceptions,
});
if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Standalone scan passed for current files and commit/path/blob history.");
}
