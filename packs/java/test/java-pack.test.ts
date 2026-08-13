import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validatePluginManifest } from "@universal-harness-internal/plugin-sdk";

import {
  JAVA_PACK,
  JAVA_PACK_DIGEST,
  JAVA_PACK_MANIFEST,
  createJavaGateProvider,
  createJavaStackAdapter,
  javaProviderInstructionTemplate,
  loadJavaPack,
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-pack-java-")));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

const JAVA_PROJECT: Readonly<Record<string, string>> = {
  "pom.xml": "<project />\n",
  "src/main/java/example/App.java": "package example;\nclass App {}\n",
  "src/test/java/example/AppTest.java": "package example;\nclass AppTest {}\n",
  "target/ignored.java": "class ignored {}\n",
};

describe("java pack descriptor", () => {
  it("loads deterministically with a stable digest and a valid manifest", () => {
    expect(loadJavaPack()).toEqual(JAVA_PACK);
    expect(HEX_DIGEST.test(JAVA_PACK_DIGEST)).toBe(true);
    expect(JAVA_PACK.stack).toBe("java");
    expect(validatePluginManifest(JAVA_PACK_MANIFEST).kind).toBe("stack");
  });

  it("declares a mandatory stack test gate and a non-mandatory build gate", () => {
    const gates = createJavaGateProvider().listGates();
    expect(gates.find((gate) => gate.gate_id === "gate_java_test")?.mandatory).toBe(true);
    expect(gates.find((gate) => gate.gate_id === "gate_java_build")?.mandatory).toBe(false);
  });

  it("provides a provider instruction template naming the governed test tool", () => {
    expect(javaProviderInstructionTemplate()).toContain("java_test");
  });
});

describe("java stack adapter", () => {
  it("detects a java project from its markers with evidence", async () => {
    const detection = await createJavaStackAdapter().detect(makeFixture(JAVA_PROJECT));
    expect(detection?.stack).toBe("java");
    expect(detection?.confidence).toBe(0.9);
    expect(detection?.evidence).toEqual(["pom.xml"]);
  });

  it("does not claim a repository without markers", async () => {
    const detection = await createJavaStackAdapter().detect(makeFixture({ "README.md": "x\n" }));
    expect(detection).toBeNull();
  });

  it("scans deterministically and derives test relations from the standard layout", async () => {
    const adapter = createJavaStackAdapter();
    const root = makeFixture(JAVA_PROJECT);
    const first = await adapter.scan(root);
    const second = await adapter.scan(root);
    expect(second).toEqual(first);

    const byPath = new Map(first.artifacts.map((artifact) => [artifact.path, artifact]));
    expect(byPath.get("pom.xml")?.kind).toBe("manifest");
    expect(byPath.get("src/main/java/example/App.java")).toMatchObject({
      kind: "code",
      language: "java",
    });
    expect(byPath.get("src/test/java/example/AppTest.java")?.kind).toBe("test");
    expect(byPath.has("target/ignored.java")).toBe(false);
    for (const artifact of first.artifacts) {
      expect(artifact.path.includes("..")).toBe(false);
      expect(artifact.path.startsWith("/")).toBe(false);
    }
    expect(first.relations).toEqual([
      {
        from_path: "src/test/java/example/AppTest.java",
        to_path: "src/main/java/example/App.java",
        kind: "tests",
      },
    ]);
  });

  it("names its declared gates in the stack defaults", () => {
    const defaults = createJavaStackAdapter().defaults();
    expect(defaults.pack).toBe(JAVA_PACK.name);
    expect(defaults.gates).toEqual(["gate_java_test", "gate_java_build"]);
  });
});
