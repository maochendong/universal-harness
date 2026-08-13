import { afterEach, describe, expect, it } from "vitest";

import { packDigest } from "@universal-harness-internal/plugin-sdk";

import {
  PackError,
  decideAction,
  installUpstreamPack,
  mergePolicyLayers,
  policyNumber,
  policyStrings,
  readProjectPackOverride,
  readUpstreamPack,
  resolvePackPolicyLayers,
  writeProjectPackOverride,
} from "../../src/index.js";
import { action, field, layer } from "../policy/fixtures.js";
import { PACK_NAME, cleanupTempProjects, makePackDescriptor, makeTempProject } from "./fixtures.js";

afterEach(cleanupTempProjects);

describe("pack resolver store", () => {
  it("installs and reads back an upstream pack with its canonical digest", () => {
    const { harnessRoot } = makeTempProject();
    const descriptor = makePackDescriptor();
    const installed = installUpstreamPack(harnessRoot, descriptor);
    expect(installed.action).toBe("created");
    expect(installed.digest).toBe(packDigest(descriptor));
    expect(readUpstreamPack(harnessRoot, PACK_NAME)).toEqual(descriptor);
  });

  it("treats re-installing identical content as an idempotent no-op", () => {
    const { harnessRoot } = makeTempProject();
    const descriptor = makePackDescriptor();
    installUpstreamPack(harnessRoot, descriptor);
    expect(installUpstreamPack(harnessRoot, descriptor).action).toBe("identical");
  });

  it("refuses to overwrite an installed pack with diverging content", () => {
    const { harnessRoot } = makeTempProject();
    installUpstreamPack(harnessRoot, makePackDescriptor());
    expect(() =>
      installUpstreamPack(
        harnessRoot,
        makePackDescriptor({ templates: { provider_instruction: "# Other\n" } }),
      ),
    ).toThrowError(PackError);
  });

  it("fails with a typed error when no upstream pack is installed", () => {
    const { harnessRoot } = makeTempProject();
    try {
      readUpstreamPack(harnessRoot, PACK_NAME);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackError);
      expect((error as PackError).kind).toBe("pack_not_found");
    }
  });

  it("stores project overrides separately and versions every replacement", () => {
    const { harnessRoot } = makeTempProject();
    const first = writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("loop.max_steps", "hard_ceiling", 20)],
    });
    expect(first.revision).toBe(1);
    const identical = writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("loop.max_steps", "hard_ceiling", 20)],
    });
    expect(identical.revision).toBe(1);
    expect(() =>
      writeProjectPackOverride(harnessRoot, {
        pack: PACK_NAME,
        fields: [field("loop.max_steps", "hard_ceiling", 10)],
      }),
    ).toThrowError(PackError);
    const replaced = writeProjectPackOverride(
      harnessRoot,
      { pack: PACK_NAME, fields: [field("loop.max_steps", "hard_ceiling", 10)] },
      { replace: true },
    );
    expect(replaced.revision).toBe(2);
    expect(readProjectPackOverride(harnessRoot, PACK_NAME)?.revision).toBe(2);
  });
});

describe("pack policy merge through the resolver (plan Task 25 step 3)", () => {
  function resolvedLayers(harnessRoot: string) {
    const resolved = resolvePackPolicyLayers(harnessRoot, PACK_NAME);
    return [resolved.pack, ...(resolved.project === undefined ? [] : [resolved.project])];
  }

  it("binds the pack layer to the canonical digest and the project layer to its revision", () => {
    const { harnessRoot } = makeTempProject();
    const descriptor = makePackDescriptor();
    installUpstreamPack(harnessRoot, descriptor);
    writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("loop.max_steps", "hard_ceiling", 20)],
    });
    const resolved = resolvePackPolicyLayers(harnessRoot, PACK_NAME);
    expect(resolved.pack.digest).toBe(packDigest(descriptor));
    expect(resolved.project?.revision).toBe(1);
    expect(resolved.project?.fields).toHaveLength(1);
  });

  it("never lets a project relax the installation hard bound; the ceiling takes the minimum", () => {
    const { harnessRoot } = makeTempProject();
    installUpstreamPack(harnessRoot, makePackDescriptor());
    writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("loop.max_steps", "hard_ceiling", 20)],
    });
    const installation = layer("installation", [field("loop.max_steps", "hard_ceiling", 10)]);
    const merged = mergePolicyLayers([installation, ...resolvedLayers(harnessRoot)]);
    expect(merged.conflicts).toEqual([]);
    expect(policyNumber(merged.effective, "loop.max_steps")).toBe(10);
  });

  it("intersects allow sets across installation, pack and project layers", () => {
    const { harnessRoot } = makeTempProject();
    installUpstreamPack(harnessRoot, makePackDescriptor());
    writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("paths.read.allow", "allow_intersection", ["src"])],
    });
    const installation = layer("installation", [
      field("paths.read.allow", "allow_intersection", ["src", "test"]),
    ]);
    const merged = mergePolicyLayers([installation, ...resolvedLayers(harnessRoot)]);
    expect(policyStrings(merged.effective, "paths.read.allow")).toEqual(["src"]);
  });

  it("unions deny sets across layers and a deny always beats an allow", () => {
    const { harnessRoot } = makeTempProject();
    installUpstreamPack(harnessRoot, makePackDescriptor());
    writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("paths.deny", "deny_union", ["secrets"])],
    });
    const layers = [
      layer("installation", [field("paths.deny", "deny_union", [".harness/locks"])]),
      ...resolvedLayers(harnessRoot),
    ];
    const merged = mergePolicyLayers(layers);
    expect(policyStrings(merged.effective, "paths.deny")).toEqual([
      ".git",
      ".harness/locks",
      "secrets",
    ]);
    const decision = decideAction(
      layers,
      action({
        kind: "write_path",
        actor_kind: "harness",
        origin: "control_plane",
        phase: "implementation",
        resource: "secrets/api-key.txt",
      }),
    );
    expect(decision.outcome).toBe("deny");
  });

  it("unions approval requirements across layers", () => {
    const { harnessRoot } = makeTempProject();
    installUpstreamPack(harnessRoot, makePackDescriptor());
    writeProjectPackOverride(harnessRoot, {
      pack: PACK_NAME,
      fields: [field("approvals.required", "approval_union", ["write_path"])],
    });
    const installation = layer("installation", [
      field("approvals.required", "approval_union", ["risk:medium"]),
    ]);
    const merged = mergePolicyLayers([installation, ...resolvedLayers(harnessRoot)]);
    expect(policyStrings(merged.effective, "approvals.required")).toEqual([
      "risk:high",
      "risk:medium",
      "write_path",
    ]);
  });
});
