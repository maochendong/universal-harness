import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function stripRepositoryPathReferences(content) {
  return content.replace(
    /(?:^|[\s`("'=:])(?:\.{0,2}\/)?(?:adapters|docs|examples|packages|scripts|teach|tests)\/[^\s`"')<>]+/gmu,
    " ",
  );
}

function contentViolations(label, content, options = {}) {
  const results = [];
  const brandContent = options.ignoreRepositoryPathReferences
    ? stripRepositoryPathReferences(content)
    : content;
  for (const brand of forbiddenBrands) {
    if (brandContent.toLocaleLowerCase("en-US").includes(brand.toLocaleLowerCase("en-US"))) {
      results.push(`${label}: forbidden former-product brand`);
    }
  }
  for (const pattern of userPathPatterns) {
    if (pattern.test(content)) results.push(`${label}: absolute user path`);
  }
  return results;
}

function currentFiles(cwd) {
  return git(cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean);
}

function changedHistoricalBlobs(cwd) {
  const tokens = git(
    cwd,
    "log",
    "--all",
    "--root",
    "--format=COMMIT%x00%H%x00",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "-z",
  ).split("\0");
  const tuples = [];
  let commit = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]?.trim();
    if (token === "COMMIT") {
      commit = tokens[index + 1]?.trim() ?? "";
      index += 1;
      continue;
    }
    if (token === undefined || !token.startsWith(":")) continue;
    const path = tokens[index + 1];
    index += 1;
    if (path === undefined || commit.length === 0) continue;
    const fields = token.split(/\s+/u);
    const blobDigest = fields[3];
    const status = fields[4];
    if (
      blobDigest === undefined ||
      status === undefined ||
      status === "D" ||
      /^0+$/u.test(blobDigest)
    ) {
      continue;
    }
    tuples.push({ commit, path, blob_digest: blobDigest });
  }
  return tuples;
}

function readHistoricalBlobs(cwd, digests) {
  const uniqueDigests = [...new Set(digests)];
  if (uniqueDigests.length === 0) return new Map();
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd,
    input: `${uniqueDigests.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  const blobs = new Map();
  let offset = 0;
  for (const digest of uniqueDigests) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) throw new Error(`missing git cat-file header for ${digest}`);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const fields = header.split(" ");
    const size = Number(fields[2]);
    if (fields[0] !== digest || fields[1] !== "blob" || !Number.isSafeInteger(size)) {
      throw new Error(`invalid git cat-file response for ${digest}: ${header}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    blobs.set(digest, output.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  return blobs;
}

function exceptionKey(tuple) {
  return `${tuple.commit}\0${tuple.path}\0${tuple.blob_digest}`;
}

function historyLabel(tuple) {
  return `history commit=${tuple.commit} path=${tuple.path} blob=${tuple.blob_digest}`;
}

/**
 * Scan current repository content and every blob introduced or changed in
 * reachable history. Historical path references are identifiers rather than
 * branded prose; the referenced path itself is still scanned independently.
 *
 * @param {{
 *   readonly cwd: string;
 *   readonly exceptions: readonly {
 *     readonly commit: string;
 *     readonly path: string;
 *     readonly blob_digest: string;
 *     readonly reason: string;
 *   }[];
 * }} input
 * @returns {string[]}
 */
export function scanStandaloneRepository(input) {
  const findings = [];
  const files = currentFiles(input.cwd);
  for (const file of files) {
    if (!existsSync(join(input.cwd, file))) continue;
    findings.push(...contentViolations(`path ${file}`, file));
    const content = readFileSync(join(input.cwd, file));
    if (!content.includes(0)) {
      findings.push(
        ...contentViolations(`file ${file}`, content.toString("utf8"), {
          ignoreRepositoryPathReferences: file === "scripts/standalone-history-exceptions.json",
        }),
      );
    }
  }

  const exceptionKeys = new Set(input.exceptions.map(exceptionKey));
  const historicalTuples = changedHistoricalBlobs(input.cwd);
  const historicalBlobs = readHistoricalBlobs(
    input.cwd,
    historicalTuples.map((tuple) => tuple.blob_digest),
  );
  for (const tuple of historicalTuples) {
    const label = historyLabel(tuple);
    const tupleFindings = [
      ...contentViolations(label, tuple.path),
      ...(() => {
        const content = historicalBlobs.get(tuple.blob_digest);
        if (content === undefined) throw new Error(`missing historical blob ${tuple.blob_digest}`);
        return content.includes(0)
          ? []
          : contentViolations(label, content.toString("utf8"), {
              ignoreRepositoryPathReferences: true,
            });
      })(),
    ];
    if (tupleFindings.length > 0 && !exceptionKeys.has(exceptionKey(tuple))) {
      findings.push(...tupleFindings);
    }
  }

  const cliManifestPath = join(input.cwd, "packages", "cli", "package.json");
  if (existsSync(cliManifestPath)) {
    const cliManifest = JSON.parse(readFileSync(cliManifestPath, "utf8"));
    for (const required of [
      "@universal-harness-internal/dashboard",
      "@universal-harness-internal/adapter-gate-llm-judge",
    ]) {
      if (cliManifest.dependencies?.[required] === undefined) {
        findings.push(`packages/cli/package.json: missing M2 runtime dependency ${required}`);
      }
    }
  }
  for (const asset of ["dashboard.html", "dashboard.css", "dashboard.js"]) {
    const path = join(input.cwd, "packages", "dashboard", "assets", asset);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    if (/\b(?:https?:)?\/\//u.test(content)) {
      findings.push(`${path}: Dashboard assets must not load remote resources`);
    }
  }

  return [...new Set(findings)];
}
