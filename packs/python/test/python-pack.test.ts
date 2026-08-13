import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validatePluginManifest } from "@universal-harness-internal/plugin-sdk";

import {
  PYTHON_PACK,
  PYTHON_PACK_DIGEST,
  PYTHON_PACK_MANIFEST,
  createPythonGateProvider,
  createPythonStackAdapter,
  loadPythonPack,
  pythonProviderInstructionTemplate,
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-pack-python-")));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

const PYTHON_PROJECT: Readonly<Record<string, string>> = {
  "pyproject.toml": '[project]\nname = "fixture"\n',
  "src/app.py": "def answer():\n    return 42\n",
  "tests/test_app.py": "from app import answer\n",
  ".venv/ignored.py": "raise SystemExit\n",
};

describe("python pack descriptor", () => {
  it("loads deterministically with a stable digest and a valid manifest", () => {
    expect(loadPythonPack()).toEqual(PYTHON_PACK);
    expect(HEX_DIGEST.test(PYTHON_PACK_DIGEST)).toBe(true);
    expect(PYTHON_PACK.stack).toBe("python");
    expect(validatePluginManifest(PYTHON_PACK_MANIFEST).kind).toBe("stack");
  });

  it("declares a mandatory stack test gate and a non-mandatory lint gate", () => {
    const gates = createPythonGateProvider().listGates();
    expect(gates.find((gate) => gate.gate_id === "gate_python_test")?.mandatory).toBe(true);
    expect(gates.find((gate) => gate.gate_id === "gate_python_lint")?.mandatory).toBe(false);
  });

  it("provides a provider instruction template naming the governed test tool", () => {
    expect(pythonProviderInstructionTemplate()).toContain("python_test");
  });
});

describe("python stack adapter", () => {
  it("detects a python project from its markers with evidence", async () => {
    const detection = await createPythonStackAdapter().detect(makeFixture(PYTHON_PROJECT));
    expect(detection?.stack).toBe("python");
    expect(detection?.confidence).toBe(0.9);
    expect(detection?.evidence).toEqual(["pyproject.toml"]);
  });

  it("does not claim a repository without markers", async () => {
    const detection = await createPythonStackAdapter().detect(makeFixture({ "README.md": "x\n" }));
    expect(detection).toBeNull();
  });

  it("scans deterministically and derives test relations from path rules", async () => {
    const adapter = createPythonStackAdapter();
    const root = makeFixture(PYTHON_PROJECT);
    const first = await adapter.scan(root);
    const second = await adapter.scan(root);
    expect(second).toEqual(first);

    const byPath = new Map(first.artifacts.map((artifact) => [artifact.path, artifact]));
    expect(byPath.get("pyproject.toml")?.kind).toBe("manifest");
    expect(byPath.get("src/app.py")).toMatchObject({ kind: "code", language: "python" });
    expect(byPath.get("tests/test_app.py")?.kind).toBe("test");
    expect(byPath.has(".venv/ignored.py")).toBe(false);
    for (const artifact of first.artifacts) {
      expect(artifact.path.includes("..")).toBe(false);
      expect(artifact.path.startsWith("/")).toBe(false);
    }
    expect(first.relations).toEqual([
      { from_path: "tests/test_app.py", to_path: "src/app.py", kind: "tests" },
    ]);
  });

  it("names its declared gates in the stack defaults", () => {
    const defaults = createPythonStackAdapter().defaults();
    expect(defaults.pack).toBe(PYTHON_PACK.name);
    expect(defaults.gates).toEqual(["gate_python_test", "gate_python_lint"]);
  });
});
