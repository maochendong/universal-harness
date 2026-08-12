import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  return execFileSync("git", args, { encoding: "utf8" });
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

if (findings.length > 0) {
  console.error([...new Set(findings)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Standalone scan passed for ${files.length} files and Git history.`);
}
