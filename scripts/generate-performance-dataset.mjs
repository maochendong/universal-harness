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
 * Event-stream mode (transparency/SSE design 7.3, plan Task 1 Step 5) emits a
 * real temporary Ledger instead of the M1 graph: <files> committed
 * manifest-shard pairs under `.harness/ledger/operations` and `.harness/events`,
 * carrying <events> schema-valid LifecycleEvent records in total. Layouts follow
 * the spec: the E layout scales event count at a fixed file count, the F layout
 * scales the manifest-shard pair count; `--layout` only records intent in the
 * metadata. Every digest is recomputed with the same canonicalization the core
 * Ledger uses, so the strict reader accepts the fixture byte-for-byte.
 *
 * Usage: node scripts/generate-performance-dataset.mjs --mode=event-stream \
 *   --out <project-root> --events <count> --files <pairs> [--layout e|f] [--seed n]
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

/** Deterministic uint32 PRNG; the only entropy source in event-stream mode. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
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

const EVENT_STREAM_BASELINE = "abcdef0123456789";
const EVENT_STREAM_MONTH = FIXED_TIMESTAMP.slice(0, 7);

function eventStreamOperationId(index) {
  return `ledger_op${pad(index + 1, 7)}`;
}

/** Mirrors packages/core/src/ledger/repository.ts serializeJsonl. */
function serializeJsonl(records) {
  if (records.length === 0) return "";
  return `${records.map((record) => canonicalize(record)).join("\n")}\n`;
}

function makeEventStreamEvent(operationId, sequence, random) {
  return {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "event",
    event_id: `event_${operationId.slice(7)}_s${pad(sequence, 7)}`,
    event_type: "OperationStarted",
    project_id: "project_perf",
    iteration_id: ITERATION_ID,
    workflow_operation_id: `workflow_${operationId.slice(7)}`,
    ledger_operation_id: operationId,
    sequence,
    timestamp: FIXED_TIMESTAMP,
    payload: { nonce: pad(random().toString(16), 8) },
  };
}

/** Mirrors buildManifest in packages/core/src/ledger/transaction.ts. */
function makeEventStreamManifest(operationId, sequence, eventFile, eventFileDigest) {
  const content = {
    protocol_version: PROTOCOL_VERSION,
    record_kind: "ledger_operation",
    ledger_operation_id: operationId,
    workflow_operation_id: `workflow_${operationId.slice(7)}`,
    attempt_id: `attempt_${operationId.slice(7)}`,
    baseline_commit: EVENT_STREAM_BASELINE,
    sequence,
    artifact_digests: [],
    edge_file: `ledger/edges/${EVENT_STREAM_MONTH}/${operationId}.jsonl`,
    event_file: eventFile,
    edge_file_digest: sha256Hex(""),
    event_file_digest: eventFileDigest,
  };
  return { ...content, committed_at: FIXED_TIMESTAMP, digest: sha256Hex(canonicalize(content)) };
}

/**
 * Emit `<files>` committed manifest-shard pairs carrying `<events>` events in
 * total, distributed round-robin so every shard differs by at most one event.
 */
function generateEventStreamFiles(options) {
  const random = mulberry32(options.seed);
  const base = Math.floor(options.events / options.files);
  const remainder = options.events % options.files;
  const entries = [];
  const manifestDigests = [];
  for (let index = 0; index < options.files; index += 1) {
    const operationId = eventStreamOperationId(index);
    const count = base + (index < remainder ? 1 : 0);
    const events = [];
    for (let sequence = 1; sequence <= count; sequence += 1) {
      events.push(makeEventStreamEvent(operationId, sequence, random));
    }
    const eventContent = serializeJsonl(events);
    const eventFile = `events/${EVENT_STREAM_MONTH}/${operationId}.jsonl`;
    const manifest = makeEventStreamManifest(
      operationId,
      index + 1,
      eventFile,
      sha256Hex(eventContent),
    );
    manifestDigests.push(manifest.digest);
    entries.push(
      {
        path: `.harness/ledger/operations/${operationId}.json`,
        content: `${JSON.stringify(manifest)}\n`,
      },
      { path: `.harness/${eventFile}`, content: eventContent },
      { path: `.harness/ledger/edges/${EVENT_STREAM_MONTH}/${operationId}.jsonl`, content: "" },
    );
  }
  return { entries, manifestDigests };
}

function generateEventStreamDataset(options) {
  const { entries, manifestDigests } = generateEventStreamFiles(options);
  const metadata = {
    name: "event-stream-performance-dataset",
    generator: "scripts/generate-performance-dataset.mjs",
    version: 1,
    mode: "event-stream",
    layout: options.layout,
    seed: options.seed,
    event_count: options.events,
    file_count: options.files,
    shard_month: EVENT_STREAM_MONTH,
    dataset_digest: sha256Hex(manifestDigests.join(":")),
  };
  entries.push({
    path: "event-stream-dataset.json",
    content: `${JSON.stringify(metadata, null, 2)}\n`,
  });

  const temporary = `${options.out}.tmp-${String(process.pid)}`;
  rmSync(temporary, { recursive: true, force: true });
  for (const entry of entries) {
    const path = join(temporary, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.content, "utf8");
  }
  publishAtomically(temporary, options.out, "event-stream-dataset.json");
}

const GRAPH_MODE_DEFAULT_OUT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "node_modules",
  ".cache",
  "universal-harness",
  "performance-dataset",
);

function parseInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} requires a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    mode: "graph",
    out: GRAPH_MODE_DEFAULT_OUT,
    events: 1000,
    files: 1,
    layout: "custom",
    seed: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equalAt = argument.indexOf("=");
    const flag = equalAt === -1 ? argument : argument.slice(0, equalAt);
    let inline = equalAt === -1 ? undefined : argument.slice(equalAt + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} requires an argument`);
      index += 1;
      return next;
    };
    if (flag === "--out") {
      options.out = resolve(value());
    } else if (flag === "--mode") {
      options.mode = value();
      if (options.mode !== "graph" && options.mode !== "event-stream") {
        throw new Error(`unknown mode: ${options.mode}`);
      }
    } else if (flag === "--events") {
      options.events = parseInteger("--events", value());
    } else if (flag === "--files") {
      options.files = parseInteger("--files", value());
    } else if (flag === "--seed") {
      options.seed = parseInteger("--seed", value());
    } else if (flag === "--layout") {
      options.layout = value();
      if (options.layout !== "e" && options.layout !== "f" && options.layout !== "custom") {
        throw new Error(`unknown layout: ${options.layout}`);
      }
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function publishAtomically(temporary, out, marker) {
  try {
    rmSync(out, { recursive: true, force: true });
    renameSync(temporary, out);
  } catch (error) {
    // A concurrent worker may have published an identical dataset first;
    // deterministic content makes that equivalent to publishing ourselves.
    rmSync(temporary, { recursive: true, force: true });
    if (!existsSync(join(out, marker))) throw error;
  }
}

function generateGraphDataset(options) {
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
  publishAtomically(temporary, options.out, "manifest.json");

  const check = JSON.parse(readFileSync(join(options.out, "manifest.json"), "utf8"));
  process.stdout.write(
    `${JSON.stringify({ out: options.out, node_count: check.node_count, edge_count: check.edge_count, dataset_digest: check.dataset_digest })}\n`,
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "event-stream") {
    generateEventStreamDataset(options);
    return;
  }
  generateGraphDataset(options);
}

main();
