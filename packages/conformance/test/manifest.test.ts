import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PluginManifestError,
  assertManifestSatisfies,
  validateAgentControlProfileClaim,
  validatePluginManifest,
} from "@universal-harness-internal/plugin-sdk";

import {
  assertConformance,
  fixturePluginManifest,
  manifestConformanceCases,
  runConformanceSuite,
} from "../src/index.js";

const exampleManifestPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../examples/plugin-minimal/plugin.json",
);

function expectManifestError(raw: unknown, kind: string): void {
  try {
    validatePluginManifest(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(PluginManifestError);
    expect((error as PluginManifestError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected a PluginManifestError of kind ${kind}`);
}

describe("plugin manifest pre-execution validation", () => {
  it("accepts a valid capability manifest", () => {
    const manifest = validatePluginManifest(fixturePluginManifest());
    expect(manifest.name).toBe("@fixture/tool-provider");
    expect(manifest.kind).toBe("tool");
  });

  it("rejects an incompatible protocol version before execution", () => {
    expectManifestError(
      fixturePluginManifest({ protocol_version: "2.0.0" }),
      "incompatible_protocol",
    );
  });

  it("rejects a structurally false manifest before execution", () => {
    expectManifestError(fixturePluginManifest({ kind: "wizard" }), "invalid_manifest");
    expectManifestError(fixturePluginManifest({ name: "Bad Name" }), "invalid_manifest");
    expectManifestError(
      fixturePluginManifest({ capabilities: ["tool.echo", "tool.echo"] }),
      "invalid_manifest",
    );
  });

  it("refuses capabilities and resources the manifest did not declare", () => {
    const manifest = validatePluginManifest(fixturePluginManifest());
    assertManifestSatisfies(manifest, { capabilities: ["tool.echo"] });

    for (const [requirements, kind] of [
      [{ capabilities: ["tool.delete"] }, "undeclared_capability"],
      [{ resources: ["network"] }, "undeclared_resource"],
    ] as const) {
      try {
        assertManifestSatisfies(manifest, requirements);
      } catch (error) {
        expect(error).toBeInstanceOf(PluginManifestError);
        expect((error as PluginManifestError).kind).toBe(kind);
        continue;
      }
      throw new Error(`expected a PluginManifestError of kind ${kind}`);
    }
  });

  it("rejects a control profile claim the profile itself contradicts", () => {
    const base = {
      provider: "fixture",
      usage_metering: true,
      side_effect_interception: true,
      resume_semantics: "explicit",
    };
    let thrown: unknown;
    try {
      validateAgentControlProfileClaim({
        ...base,
        control: "managed",
        trajectory_visibility: "summarized",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PluginManifestError);
    expect((thrown as PluginManifestError).kind).toBe("unproven_control_profile");

    const delegated = validateAgentControlProfileClaim({
      ...base,
      control: "delegated",
      trajectory_visibility: "summarized",
    });
    expect(delegated.control).toBe("delegated");
  });

  it("passes the minimal example plugin manifest through the shared suite", async () => {
    const raw = JSON.parse(readFileSync(exampleManifestPath, "utf8")) as unknown;
    const report = await runConformanceSuite({
      plugin: "example-plugin-minimal",
      kind: "tool",
      cases: manifestConformanceCases(raw),
    });
    assertConformance(report);

    const manifest = validatePluginManifest(raw);
    assertManifestSatisfies(manifest, { capabilities: ["tool.echo"] });
  });
});
