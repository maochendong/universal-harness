import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validatePluginManifest } from "@universal-harness-internal/plugin-sdk";

import {
  NODE_PACK,
  NODE_PACK_DIGEST,
  NODE_PACK_MANIFEST,
  createNodeGateProvider,
  createNodeStackAdapter,
  loadNodePack,
  nodeProviderInstructionTemplate,
} from "../src/index.js";

const HEX_DIGEST = /^[a-f0-9]{64}$/u;

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function makeFixture(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-pack-node-")));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

const NODE_PROJECT: Readonly<Record<string, string>> = {
  "package.json": '{ "name": "fixture", "type": "module" }\n',
  "tsconfig.json": '{ "compilerOptions": {} }\n',
  "src/index.ts": "export const answer = 42;\n",
  "test/index.test.ts": "import { answer } from '../src/index.js';\n",
  "node_modules/ignored/index.js": "module.exports = {};\n",
};

describe("node pack descriptor", () => {
  it("loads deterministically with a stable digest and a valid manifest", () => {
    expect(loadNodePack()).toEqual(NODE_PACK);
    expect(HEX_DIGEST.test(NODE_PACK_DIGEST)).toBe(true);
    expect(NODE_PACK.stack).toBe("node");
    expect(validatePluginManifest(NODE_PACK_MANIFEST).kind).toBe("stack");
  });

  it("declares a mandatory stack test gate and a non-mandatory lint gate", () => {
    const gates = createNodeGateProvider().listGates();
    const test = gates.find((gate) => gate.gate_id === "gate_node_test");
    const lint = gates.find((gate) => gate.gate_id === "gate_node_lint");
    expect(test?.mandatory).toBe(true);
    expect(test?.layer).toBe("stack");
    expect(test?.tool).toBe("node_test");
    expect(lint?.mandatory).toBe(false);
  });

  it("provides a provider instruction template naming the governed test tool", () => {
    expect(nodeProviderInstructionTemplate()).toContain("node_test");
  });
});

describe("node stack adapter", () => {
  it("detects a node project from its markers with evidence", async () => {
    const adapter = createNodeStackAdapter();
    const detection = await adapter.detect(makeFixture(NODE_PROJECT));
    expect(detection?.stack).toBe("node");
    expect(detection?.confidence).toBe(0.9);
    expect(detection?.evidence).toEqual(["package.json"]);
  });

  it("does not claim a repository without markers", async () => {
    const detection = await createNodeStackAdapter().detect(makeFixture({ "README.md": "x\n" }));
    expect(detection).toBeNull();
  });

  it("scans deterministically and derives test relations from path rules", async () => {
    const adapter = createNodeStackAdapter();
    const root = makeFixture(NODE_PROJECT);
    const first = await adapter.scan(root);
    const second = await adapter.scan(root);
    expect(second).toEqual(first);

    const byPath = new Map(first.artifacts.map((artifact) => [artifact.path, artifact]));
    expect(byPath.get("package.json")?.kind).toBe("manifest");
    expect(byPath.get("tsconfig.json")?.kind).toBe("config");
    expect(byPath.get("src/index.ts")).toMatchObject({ kind: "code", language: "typescript" });
    expect(byPath.get("test/index.test.ts")).toMatchObject({ kind: "test" });
    expect(byPath.has("node_modules/ignored/index.js")).toBe(false);
    for (const artifact of first.artifacts) {
      expect(artifact.path.includes("..")).toBe(false);
      expect(artifact.path.startsWith("/")).toBe(false);
    }
    expect(first.relations).toEqual([
      { from_path: "test/index.test.ts", to_path: "src/index.ts", kind: "tests" },
    ]);
  });

  it("names its declared gates in the stack defaults", () => {
    const defaults = createNodeStackAdapter().defaults();
    expect(defaults.pack).toBe(NODE_PACK.name);
    expect(defaults.gates).toEqual(["gate_node_test", "gate_node_lint"]);
  });
});
