import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validatePluginManifest } from "@universal-harness-internal/plugin-sdk";

import {
  GENERIC_PACK,
  GENERIC_PACK_DIGEST,
  GENERIC_PACK_MANIFEST,
  createGenericGateProvider,
  createGenericStackAdapter,
  genericPackPolicies,
  genericPackPolicyNumber,
  genericProviderInstructionTemplate,
  loadGenericPack,
} from "../src/index.js";

const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const PRINTABLE_ASCII = /^[\t\n\x20-\x7e]*$/u;

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-pack-generic-")));
  created.push(directory);
  return directory;
}

describe("generic pack descriptor", () => {
  it("loads the canonical descriptor deterministically with a stable digest", () => {
    expect(loadGenericPack()).toEqual(GENERIC_PACK);
    expect(HEX_DIGEST.test(GENERIC_PACK_DIGEST)).toBe(true);
    expect(GENERIC_PACK.stack).toBe("generic");
    expect(GENERIC_PACK.version).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("carries the approved M1 LoopPolicy ceilings as hard_ceiling fields", () => {
    const paths = genericPackPolicies().map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(genericPackPolicyNumber("loop.max_steps")).toBe(30);
    expect(genericPackPolicyNumber("loop.max_tokens")).toBe(120000);
    expect(genericPackPolicyNumber("loop.max_duration_ms")).toBe(2700000);
    expect(genericPackPolicyNumber("loop.max_tool_retries")).toBe(2);
    for (const path of [
      "loop.max_steps",
      "loop.max_tokens",
      "loop.max_duration_ms",
      "loop.max_tool_retries",
    ]) {
      const entry = genericPackPolicies().find((candidate) => candidate.path === path);
      expect(entry?.merge_operator).toBe("hard_ceiling");
    }
  });

  it("declares a valid stack plugin manifest", () => {
    const manifest = validatePluginManifest(GENERIC_PACK_MANIFEST);
    expect(manifest.kind).toBe("stack");
    expect(manifest.name).toBe(GENERIC_PACK.name);
  });
});

describe("generic pack gates and templates", () => {
  it("contributes no stack-profile gates", () => {
    expect(createGenericGateProvider().listGates()).toEqual([]);
  });

  it("provides a neutral ASCII provider instruction template", () => {
    const template = genericProviderInstructionTemplate();
    expect(template).toContain("Universal Harness");
    expect(PRINTABLE_ASCII.test(template)).toBe(true);
  });
});

describe("generic stack adapter", () => {
  it("detects everywhere at confidence 0 so any real stack wins", async () => {
    const adapter = createGenericStackAdapter();
    const detection = await adapter.detect(makeTempDir());
    expect(detection).toEqual({ stack: "generic", confidence: 0, evidence: [] });
  });

  it("scans neutrally: no stack-specific artifacts or relations", async () => {
    const scan = await createGenericStackAdapter().scan(makeTempDir());
    expect(scan).toEqual({ artifacts: [], relations: [] });
  });

  it("names the canonical pack in its defaults", () => {
    const defaults = createGenericStackAdapter().defaults();
    expect(defaults.pack).toBe(GENERIC_PACK.name);
    expect(defaults.projection_views).toEqual(GENERIC_PACK.projection_views);
  });
});
