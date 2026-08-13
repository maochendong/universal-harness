import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harnessRootFor } from "@universal-harness-internal/core";
import {
  parsePackDescriptor,
  type PackDescriptor,
  type PackPolicyField,
} from "@universal-harness-internal/plugin-sdk";

/** Shared builders for deterministic pack-store tests (plan Task 25). */

const created: string[] = [];

export function cleanupTempProjects(): void {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}

/** A temporary project root with its managed `.harness` directory created. */
export function makeTempProject(): { readonly projectRoot: string; readonly harnessRoot: string } {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "harness-packs-")));
  created.push(projectRoot);
  const harnessRoot = harnessRootFor(projectRoot);
  mkdirSync(harnessRoot, { recursive: true });
  return { projectRoot, harnessRoot };
}

export const PACK_NAME = "@universal-harness-internal/pack-node";

export function packFields(): readonly PackPolicyField[] {
  return [
    { path: "loop.max_steps", merge_operator: "hard_ceiling", value: 30 },
    { path: "paths.deny", merge_operator: "deny_union", value: [".git"] },
    { path: "paths.read.allow", merge_operator: "allow_intersection", value: ["src", "docs"] },
    { path: "approvals.required", merge_operator: "approval_union", value: ["risk:high"] },
  ];
}

export function makePackDescriptor(
  overrides: {
    readonly name?: string;
    readonly version?: string;
    readonly policies?: readonly PackPolicyField[];
    readonly gates?: readonly Record<string, unknown>[];
    readonly templates?: Readonly<Record<string, string>>;
  } = {},
): PackDescriptor {
  return parsePackDescriptor({
    pack_format: 1,
    name: overrides.name ?? PACK_NAME,
    version: overrides.version ?? "1.0.0",
    stack: "node",
    policies: overrides.policies ?? packFields(),
    gates: overrides.gates ?? [
      {
        gate_id: "gate_node_test",
        layer: "stack",
        name: "node test suite",
        mandatory: true,
        subject_id: "stack_node_test",
        tool: "node_test",
      },
    ],
    templates: overrides.templates ?? { provider_instruction: "# Instructions\n" },
    projection_views: ["prd"],
  });
}
