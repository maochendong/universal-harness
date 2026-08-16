import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const forbiddenBrands = [
  ["Code", "Buddy"].join(""),
  ["Qo", "der"].join(""),
  ["QQ", "音乐"].join(""),
  ["Deer", "Flow"].join(""),
  ["deep", "mind"].join(""),
];
const userPathPatterns = [
  new RegExp(["/", "Users", "/", "[^/\\s]+"].join(""), "u"),
  new RegExp(["[A-Za-z]:", "\\\\", "Users", "\\\\", "[^\\\\\\s]+"].join(""), "u"),
];

function git(...args) {
  // The full-history scan output grows with the repository; the default
  // maxBuffer (1 MiB) overflows once committed diffs get large.
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function violations(label, content) {
  const results = [];
  for (const brand of forbiddenBrands) {
    if (content.toLocaleLowerCase("en-US").includes(brand.toLocaleLowerCase("en-US"))) {
      results.push(`${label}: forbidden former-product brand`);
    }
  }
  for (const pattern of userPathPatterns) {
    if (pattern.test(content)) results.push(`${label}: absolute user path`);
  }
  return results;
}

const files = git("ls-files", "--cached", "--others", "--exclude-standard")
  .split(/\r?\n/u)
  .filter(Boolean);
const findings = [];

for (const file of files) {
  findings.push(...violations(`path ${file}`, file));
  const content = readFileSync(file);
  if (!content.includes(0)) findings.push(...violations(`file ${file}`, content.toString("utf8")));
}

findings.push(...violations("git history", git("log", "--all", "--format=fuller", "-p")));

const cliManifest = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
for (const required of [
  "@universal-harness-internal/dashboard",
  "@universal-harness-internal/adapter-gate-llm-judge",
]) {
  if (cliManifest.dependencies?.[required] === undefined) {
    findings.push(`packages/cli/package.json: missing M2 runtime dependency ${required}`);
  }
}
for (const asset of ["dashboard.html", "dashboard.css", "dashboard.js"]) {
  const path = join("packages", "dashboard", "assets", asset);
  const content = readFileSync(path, "utf8");
  if (/\b(?:https?:)?\/\//u.test(content)) {
    findings.push(`${path}: Dashboard assets must not load remote resources`);
  }
}

if (findings.length > 0) {
  console.error([...new Set(findings)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Standalone scan passed for ${files.length} files and Git history.`);
}
