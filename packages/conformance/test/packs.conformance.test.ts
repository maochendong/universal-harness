import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GENERIC_PACK,
  GENERIC_PACK_DIGEST,
  GENERIC_PACK_MANIFEST,
  createGenericGateProvider,
  createGenericStackAdapter,
  genericProviderInstructionTemplate,
} from "@universal-harness-internal/pack-generic";
import {
  JAVA_PACK,
  JAVA_PACK_MANIFEST,
  createJavaGateProvider,
  createJavaStackAdapter,
  javaProviderInstructionTemplate,
} from "@universal-harness-internal/pack-java";
import {
  NODE_PACK,
  NODE_PACK_MANIFEST,
  createNodeGateProvider,
  createNodeStackAdapter,
  nodeProviderInstructionTemplate,
} from "@universal-harness-internal/pack-node";
import {
  PYTHON_PACK,
  PYTHON_PACK_MANIFEST,
  createPythonGateProvider,
  createPythonStackAdapter,
  pythonProviderInstructionTemplate,
} from "@universal-harness-internal/pack-python";
import {
  packDigest,
  type GateProvider,
  type PackDescriptor,
  type PluginManifest,
  type StackAdapter,
} from "@universal-harness-internal/plugin-sdk";
import { normalizeGateDefinition } from "@universal-harness-internal/runtime";

import {
  assertConformance,
  makeTempDir,
  manifestConformanceCases,
  providerInstructionConformanceCases,
  removeTempDir,
  runConformanceSuite,
  type ConformanceCase,
} from "../src/index.js";

/**
 * Pack conformance suites (plan Task 25 verification): every first-party pack
 * proves the same contract through the shared runner -- a valid manifest, a
 * reproducible canonical digest, deterministic and confined detection and
 * scanning, gates that normalize under the runtime gate contract, and a
 * provider instruction template whose mirror digest is reproducible and
 * confined to the managed projection root.
 */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function writeFixture(files: Readonly<Record<string, string>>): string {
  const root = makeTempDir("harness-conf-pack-");
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

function assertRelative(paths: readonly string[], label: string): void {
  for (const path of paths) {
    assert(
      !path.startsWith("/") && !path.includes("..") && !path.includes("\\"),
      `${label} must be repository-relative POSIX paths, got ${JSON.stringify(path)}`,
    );
  }
}

interface StackPackUnderTest {
  readonly descriptor: PackDescriptor;
  readonly manifest: PluginManifest;
  readonly adapter: StackAdapter;
  readonly gates: GateProvider;
  readonly template: string;
  readonly fixture: Readonly<Record<string, string>>;
}

function stackPackCases(pack: StackPackUnderTest): ConformanceCase[] {
  return [
    ...manifestConformanceCases(pack.manifest),
    ...providerInstructionConformanceCases({
      provider: "example-provider",
      instruction: pack.template,
      task_envelope_digest: "a".repeat(64),
      context_bundle_digest: "b".repeat(64),
    }),
    {
      name: "the canonical descriptor digest is reproducible",
      run() {
        const first = packDigest(pack.descriptor);
        const second = packDigest(pack.descriptor);
        assert(/^[a-f0-9]{64}$/u.test(first), "the pack digest must be a SHA-256 hex digest");
        assert(second === first, "the pack digest must be reproducible");
      },
    },
    {
      name: "detection is deterministic with evidence confined to the repository",
      async run() {
        const root = writeFixture(pack.fixture);
        try {
          const first = await pack.adapter.detect(root);
          const second = await pack.adapter.detect(root);
          assert(first !== null, "the adapter must detect its own fixture");
          if (first === null) return;
          assert(
            JSON.stringify(second) === JSON.stringify(first),
            "detection must be deterministic",
          );
          assert(
            first.confidence > 0 && first.confidence <= 1,
            "detection confidence must lie in (0, 1]",
          );
          assert(first.evidence.length > 0, "detection must name its evidence");
          assertRelative(first.evidence, "detection evidence");
        } finally {
          removeTempDir(root);
        }
      },
    },
    {
      name: "detection never claims a repository without markers",
      async run() {
        const root = writeFixture({ "README.md": "plain\n" });
        try {
          const detection = await pack.adapter.detect(root);
          assert(detection === null, "a markerless repository must not be claimed");
        } finally {
          removeTempDir(root);
        }
      },
    },
    {
      name: "scanning is deterministic and repository-relative",
      async run() {
        const root = writeFixture(pack.fixture);
        try {
          const first = await pack.adapter.scan(root);
          const second = await pack.adapter.scan(root);
          assert(
            JSON.stringify(second) === JSON.stringify(first),
            "two scans of identical content must agree byte-for-byte",
          );
          assert(first.artifacts.length > 0, "the stack scan must classify its fixture");
          assertRelative(
            first.artifacts.map((artifact) => artifact.path),
            "scanned artifact paths",
          );
          for (const relation of first.relations) {
            assertRelative([relation.from_path, relation.to_path], "scanned relation endpoints");
          }
        } finally {
          removeTempDir(root);
        }
      },
    },
    {
      name: "declared gates normalize under the runtime gate contract",
      run() {
        const declared = pack.gates.listGates();
        assert(declared.length > 0, "a stack pack must declare stack-profile gates");
        const ids = new Set<string>();
        for (const gate of declared) {
          const normalized = normalizeGateDefinition(gate);
          assert(!ids.has(gate.gate_id), "gate ids must be unique within a pack");
          ids.add(gate.gate_id);
          assert(normalized.layer === "stack", "pack gates must be stack-profile gates");
          assert(
            /^[a-f0-9]{64}$/u.test(normalized.digest),
            "the runtime must mint the gate digest",
          );
        }
        const defaults = pack.adapter.defaults();
        for (const gateId of defaults.gates) {
          assert(ids.has(gateId), `stack defaults reference undeclared gate ${gateId}`);
        }
        assert(defaults.pack === pack.descriptor.name, "defaults must name the canonical pack");
      },
    },
  ];
}

const STACK_PACKS: readonly StackPackUnderTest[] = [
  {
    descriptor: NODE_PACK,
    manifest: NODE_PACK_MANIFEST,
    adapter: createNodeStackAdapter(),
    gates: createNodeGateProvider(),
    template: nodeProviderInstructionTemplate(),
    fixture: {
      "package.json": '{ "name": "fixture" }\n',
      "src/index.ts": "export {};\n",
      "test/index.test.ts": "import {} from '../src/index.js';\n",
    },
  },
  {
    descriptor: PYTHON_PACK,
    manifest: PYTHON_PACK_MANIFEST,
    adapter: createPythonStackAdapter(),
    gates: createPythonGateProvider(),
    template: pythonProviderInstructionTemplate(),
    fixture: {
      "pyproject.toml": '[project]\nname = "fixture"\n',
      "src/app.py": "def answer():\n    return 42\n",
      "tests/test_app.py": "from app import answer\n",
    },
  },
  {
    descriptor: JAVA_PACK,
    manifest: JAVA_PACK_MANIFEST,
    adapter: createJavaStackAdapter(),
    gates: createJavaGateProvider(),
    template: javaProviderInstructionTemplate(),
    fixture: {
      "pom.xml": "<project />\n",
      "src/main/java/example/App.java": "package example;\nclass App {}\n",
      "src/test/java/example/AppTest.java": "package example;\nclass AppTest {}\n",
    },
  },
];

for (const pack of STACK_PACKS) {
  describe(`${pack.descriptor.name} conformance`, () => {
    it("satisfies the shared stack pack contract", async () => {
      const report = await runConformanceSuite({
        plugin: pack.descriptor.name,
        kind: "stack",
        cases: stackPackCases(pack),
      });
      assertConformance(report);
      expect(report.total).toBeGreaterThan(0);
    });
  });
}

describe("pack-generic conformance", () => {
  it("satisfies the shared stack pack contract with neutral defaults", async () => {
    const report = await runConformanceSuite({
      plugin: GENERIC_PACK.name,
      kind: "stack",
      cases: [
        ...manifestConformanceCases(GENERIC_PACK_MANIFEST),
        ...providerInstructionConformanceCases({
          provider: "example-provider",
          instruction: genericProviderInstructionTemplate(),
          task_envelope_digest: "a".repeat(64),
          context_bundle_digest: "b".repeat(64),
        }),
        {
          name: "the canonical descriptor digest is reproducible",
          run() {
            assert(/^[a-f0-9]{64}$/u.test(GENERIC_PACK_DIGEST), "digest must be hex");
          },
        },
        {
          name: "the neutral fallback detects everywhere at confidence 0",
          async run() {
            const root = writeFixture({ "README.md": "plain\n" });
            try {
              const detection = await createGenericStackAdapter().detect(root);
              assert(detection !== null, "the generic fallback applies everywhere");
              assert(
                detection?.confidence === 0,
                "the generic fallback must never outrank a stack",
              );
            } finally {
              removeTempDir(root);
            }
          },
        },
        {
          name: "the neutral scan contributes no stack-specific claims",
          async run() {
            const root = makeTempDir("harness-conf-pack-");
            try {
              const scan = await createGenericStackAdapter().scan(root);
              assert(
                scan.artifacts.length === 0 && scan.relations.length === 0,
                "the generic pack must stay neutral",
              );
            } finally {
              removeTempDir(root);
            }
          },
        },
        {
          name: "the generic pack declares no stack-profile gates",
          run() {
            assert(
              createGenericGateProvider().listGates().length === 0,
              "universal gates are owned by the runtime, not the generic pack",
            );
          },
        },
      ],
    });
    assertConformance(report);
  });
});
