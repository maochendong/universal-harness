#!/usr/bin/env node
/**
 * Deterministic M1 performance dataset generator (design 16.2, plan Task 27).
 *
 * Emits exactly 20,000 schema-valid node records and 100,000 schema-valid
 * edge records plus a manifest with content digests. Generation is a pure
 * function of the built-in constants -- no clock, no randomness, no I/O
 * beyond the final writes -- so two runs on any platform produce
 * byte-identical files, which is what the performance gate's determinism
 * assertions rely on.
 *
 * Usage: node scripts/generate-performance-dataset.mjs --out <directory>
 *
 * The output directory is published atomically (write to a sibling temporary
 * directory, then rename) so concurrent test workers never observe a half
 * generated dataset.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "1.0.0";
const FIXED_TIMESTAMP = "2026-08-01T00:00:00.000Z";
const ITERATION_ID = "iteration_perf";
const ACTOR = "performance-dataset-generator";

const REQUIREMENT_COUNT = 500;
const DECISION_COUNT = 500;
const COMPONENT_COUNT = 4000;
const CODE_COUNT = 14000;
const TEST_COUNT = 1000;
const NODE_COUNT = REQUIREMENT_COUNT + DECISION_COUNT + COMPONENT_COUNT + CODE_COUNT + TEST_COUNT;

const ADDRESSES_PER_DECISION = 2;
const VERIFIES_PER_TEST = 2;
const DERIVES_STRIDES = [7, 131, 1021, 4099, 8191];
const DERIVES_EXTRA_STRIDE = 10007;
const DERIVES_EXTRA_SOURCES = 9000;
const EDGE_COUNT =
  DECISION_COUNT * ADDRESSES_PER_DECISION +
  COMPONENT_COUNT +
  CODE_COUNT +
  TEST_COUNT * VERIFIES_PER_TEST +
  CODE_COUNT * DERIVES_STRIDES.length +
  DERIVES_EXTRA_SOURCES;

if (NODE_COUNT !== 20000 || EDGE_COUNT !== 100000) {
  throw new Error(
    `dataset constants drifted: ${NODE_COUNT} nodes / ${EDGE_COUNT} edges, expected 20000/100000`,
  );
}

function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Mirrors packages/core/src/identity/canonical-json.ts for ASCII content. */
function canonicalize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "number":
      if (!Number.isFinite(value)) throw new Error(`non-finite number ${String(value)}`);
      return JSON.stringify(value === 0 ? 0 : value);
    case "object":
      if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
      return `{${Object.keys(value)
        .map((key) => key.normalize("NFC"))
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
        .join(",")}}`;
    default:
      throw new Error(`unsupported type ${typeof value}`);
  }
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function provenance() {
  return { iteration_id: ITERATION_ID, actor: ACTOR, timestamp: FIXED_TIMESTAMP };
}

function finalizeRecord(record) {
  return { ...record, digest: sha256Hex(canonicalize(record)) };
}

function makeNode(id, type, locator) {
  const record = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "node",
    id,
    type,
    revision: 1,
    status: "accepted",
    source: "scanner",
    provenance: provenance(),
    confidence: 1,
    ...(locator === undefined ? {} : { locator }),
  };
  return finalizeRecord(record);
}

function makeEdge(sequence, type, sourceId, targetId) {
  const record = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "edge",
    id: `edge_e${pad(sequence, 7)}`,
    type,
    source_id: sourceId,
    target_id: targetId,
    status: "accepted",
    source: "scanner",
    provenance: provenance(),
    confidence: 1,
  };
  return finalizeRecord(record);
}

function requirementId(index) {
  return `requirement_r${pad(index, 5)}`;
}
function decisionId(index) {
  return `decision_d${pad(index, 5)}`;
}
function componentId(index) {
  return `component_c${pad(index, 5)}`;
}
function codeId(index) {
  return `code_m${pad(index, 5)}`;
}
function testId(index) {
  return `test_t${pad(index, 5)}`;
}

function generateNodes() {
  const nodes = [];
  for (let index = 0; index < REQUIREMENT_COUNT; index += 1) {
    nodes.push(makeNode(requirementId(index), "Requirement"));
  }
  for (let index = 0; index < DECISION_COUNT; index += 1) {
    nodes.push(makeNode(decisionId(index), "Decision"));
  }
  for (let index = 0; index < COMPONENT_COUNT; index += 1) {
    nodes.push(makeNode(componentId(index), "Component"));
  }
  for (let index = 0; index < CODE_COUNT; index += 1) {
    nodes.push(
      makeNode(codeId(index), "CodeArtifact", `repo://perf/src/module-${pad(index, 5)}.ts`),
    );
  }
  for (let index = 0; index < TEST_COUNT; index += 1) {
    nodes.push(makeNode(testId(index), "Test"));
  }
  return nodes;
}

function generateEdges() {
  const edges = [];
  let sequence = 0;
  const push = (type, sourceId, targetId) => {
    sequence += 1;
    edges.push(makeEdge(sequence, type, sourceId, targetId));
  };
  // Decision ADDRESSES Requirement (design relation registry).
  for (let index = 0; index < DECISION_COUNT; index += 1) {
    push("ADDRESSES", decisionId(index), requirementId((2 * index) % REQUIREMENT_COUNT));
    push("ADDRESSES", decisionId(index), requirementId((2 * index + 1) % REQUIREMENT_COUNT));
  }
  // Decision SHAPES Component.
  for (let index = 0; index < COMPONENT_COUNT; index += 1) {
    push("SHAPES", decisionId(index % DECISION_COUNT), componentId(index));
  }
  // CodeArtifact REALIZES Component.
  for (let index = 0; index < CODE_COUNT; index += 1) {
    push("REALIZES", codeId(index), componentId(index % COMPONENT_COUNT));
  }
  // Test VERIFIES Requirement.
  for (let index = 0; index < TEST_COUNT; index += 1) {
    push("VERIFIES", testId(index), requirementId(index % REQUIREMENT_COUNT));
    push("VERIFIES", testId(index), requirementId((index * 3 + 7) % REQUIREMENT_COUNT));
  }
  // CodeArtifact DERIVES_FROM CodeArtifact: a wide deterministic dependency
  // fabric. A stride is never a multiple of CODE_COUNT, so no self-loops.
  for (let index = 0; index < CODE_COUNT; index += 1) {
    for (const stride of DERIVES_STRIDES) {
      push("DERIVES_FROM", codeId(index), codeId((index + stride) % CODE_COUNT));
    }
    if (index < DERIVES_EXTRA_SOURCES) {
      push("DERIVES_FROM", codeId(index), codeId((index + DERIVES_EXTRA_STRIDE) % CODE_COUNT));
    }
  }
  return edges;
}

function countBy(records, key) {
  const counts = {};
  for (const record of records) {
    const value = record[key];
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function parseArgs(argv) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const options = {
    out: join(repoRoot, "node_modules", ".cache", "universal-harness", "performance-dataset"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--out requires a directory argument");
      options.out = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const nodes = generateNodes();
  const edges = generateEdges();
  const nodesContent = `${JSON.stringify(nodes)}\n`;
  const edgesContent = `${JSON.stringify(edges)}\n`;
  const manifest = {
    name: "m1-performance-dataset",
    generator: "scripts/generate-performance-dataset.mjs",
    version: 1,
    node_count: nodes.length,
    edge_count: edges.length,
    node_types: countBy(nodes, "type"),
    relation_types: countBy(edges, "type"),
    nodes_file: "nodes.json",
    edges_file: "edges.json",
    nodes_digest: sha256Hex(nodesContent),
    edges_digest: sha256Hex(edgesContent),
  };
  manifest.dataset_digest = sha256Hex(`${manifest.nodes_digest}:${manifest.edges_digest}`);
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;

  const temporary = `${options.out}.tmp-${String(process.pid)}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  writeFileSync(join(temporary, "nodes.json"), nodesContent, "utf8");
  writeFileSync(join(temporary, "edges.json"), edgesContent, "utf8");
  writeFileSync(join(temporary, "manifest.json"), manifestContent, "utf8");
  try {
    rmSync(options.out, { recursive: true, force: true });
    renameSync(temporary, options.out);
  } catch (error) {
    // A concurrent worker may have published an identical dataset first;
    // deterministic content makes that equivalent to publishing ourselves.
    rmSync(temporary, { recursive: true, force: true });
    if (!existsSync(join(options.out, "manifest.json"))) throw error;
  }

  const check = JSON.parse(readFileSync(join(options.out, "manifest.json"), "utf8"));
  process.stdout.write(
    `${JSON.stringify({ out: options.out, node_count: check.node_count, edge_count: check.edge_count, dataset_digest: check.dataset_digest })}\n`,
  );
}

main();
