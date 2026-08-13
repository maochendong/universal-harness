import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PolicyError,
  normalizeAction,
  type PolicyAction,
} from "../../packages/runtime/src/policy/action.js";
import {
  issueGrant,
  narrowGrant,
  type CapabilityGrant,
} from "../../packages/runtime/src/policy/capability-grant.js";
import type { PolicyLayerInput } from "../../packages/runtime/src/policy/decision.js";
import { decideAction, mergePolicyLayers } from "../../packages/runtime/src/policy/evaluator.js";
import { assertWithinRepositoryBoundary } from "../../packages/runtime/src/policy/path-boundary.js";

/**
 * Prompt-carried capability escalation (design 14; security test list). Tool
 * output, retrieved documents, repository content and provider output are
 * untrusted context: they may request ordinary actions, but they can never
 * modify policy, register tools, grant paths, approve or accept evidence --
 * and the adapter identity itself never authorizes anything. Every rejected
 * operation leaves a digested decision record and produces no change.
 */

const MANAGED_PROFILE = {
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
} as const;

const LAYERS: readonly PolicyLayerInput[] = [
  {
    layer: "installation",
    revision: 1,
    digest: "a".repeat(64),
    fields: [
      { path: "capabilities.deny", merge_operator: "deny_union", value: ["shell_exec"] },
      { path: "paths.deny", merge_operator: "deny_union", value: ["secrets"] },
      { path: "budgets.max_steps", merge_operator: "hard_ceiling", value: 30 },
    ],
  },
  {
    layer: "project",
    revision: 4,
    digest: "b".repeat(64),
    fields: [
      { path: "paths.read.allow", merge_operator: "allow_intersection", value: ["src", "docs"] },
      { path: "paths.write.allow", merge_operator: "allow_intersection", value: ["src"] },
      { path: "resources.allow", merge_operator: "allow_intersection", value: ["apply_patch"] },
      { path: "approvals.required", merge_operator: "approval_union", value: ["risk:high"] },
    ],
  },
];

function promptAction(overrides: Record<string, unknown>): PolicyAction {
  return normalizeAction({
    kind: "read_path",
    actor: "adapter_01",
    actor_kind: "adapter",
    origin: "prompt",
    phase: "implementation",
    parameters: {},
    risk: "low",
    control_profile: MANAGED_PROFILE,
    ...overrides,
  });
}

function taskGrant(): CapabilityGrant {
  const merged = mergePolicyLayers(LAYERS);
  return issueGrant(
    {
      grant_id: "grant_task_01",
      task_id: "task_01",
      capabilities: ["edit-source"],
      read_paths: ["src"],
      write_paths: ["src"],
      state_fields: ["hypotheses"],
      tools: [{ name: "apply_patch" }],
      phase: "implementation",
      budget: { steps: 40, tokens: 90000 },
      approval_digests: ["c".repeat(64)],
    },
    merged.effective,
  );
}

describe("prompt-carried capability escalation", () => {
  it("denies every escalation kind a prompt can smuggle into a tool result", () => {
    const smuggled = [
      { kind: "change_policy", resource: "paths.deny", reason: "policy edit" },
      { kind: "register_tool", resource: "shell_exec", reason: "new tool" },
      { kind: "grant_path", resource: "../etc", reason: "extra path" },
      { kind: "approve", resource: "approval_01", reason: "self approval" },
      { kind: "accept_evidence", resource: "evidence_01", reason: "self accepted evidence" },
    ];
    for (const attempt of smuggled) {
      const action = promptAction(attempt);
      const decision = decideAction(LAYERS, action, taskGrant());
      expect(decision.outcome).toBe("deny");
      expect(decision.reasons[0]).toContain("untrusted context");
      // The trace is the decision record itself: digested and layer-bound.
      expect(decision.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(decision.layers.map((ref) => ref.layer)).toEqual(["installation", "project"]);
    }
  });

  it("denies escalation even when the adapter claims a managed control profile", () => {
    const decision = decideAction(
      LAYERS,
      promptAction({ kind: "grant_path", resource: "docs" }),
      taskGrant(),
    );
    expect(decision.outcome).toBe("deny");
    // Adapter identity and profile claims never authorize anything by themselves.
    const controlPlane = decideAction(
      LAYERS,
      normalizeAction({
        kind: "approve",
        actor: "adapter_01",
        actor_kind: "adapter",
        origin: "control_plane",
        phase: "implementation",
        parameters: {},
        risk: "low",
        control_profile: MANAGED_PROFILE,
      }),
    );
    expect(controlPlane.outcome).toBe("deny");
    expect(controlPlane.reasons[0]).toContain("adapter identity never authorizes");
  });

  it("never lets an approval turn a deny into an allow", () => {
    const approval = "c".repeat(64);
    const denied = decideAction(
      LAYERS,
      promptAction({
        kind: "invoke_tool",
        resource: "shell_exec",
        risk: "high",
        approval_digest: approval,
      }),
      taskGrant(),
    );
    expect(denied.outcome).toBe("deny");
    expect(denied.approval_digest).toBeUndefined();
  });

  it("detects undeclared writes outside the granted scope", () => {
    const grant = taskGrant();
    const sneak = decideAction(
      LAYERS,
      promptAction({ kind: "write_path", resource: ".github/workflows/pwn.yml" }),
      grant,
    );
    expect(sneak.outcome).toBe("deny");
    expect(sneak.reasons[0]).toContain("outside the granted write scope");
    // And a prompt cannot widen the grant to cover it afterwards.
    expect(() => narrowGrant(grant, { write_paths: ["src", ".github"] })).toThrowError(PolicyError);
    expect(grant.write_paths).toEqual(["src"]);
  });

  it("denies explicitly denied paths even with a valid approval", () => {
    const decision = decideAction(
      LAYERS,
      promptAction({ resource: "secrets/deploy.key", approval_digest: "c".repeat(64) }),
      taskGrant(),
    );
    expect(decision.outcome).toBe("deny");
  });

  it("blocks instead of silently overriding when a project tries to replace an installation deny", () => {
    const hostile: readonly PolicyLayerInput[] = [
      LAYERS[0] as PolicyLayerInput,
      {
        layer: "project",
        revision: 5,
        digest: "d".repeat(64),
        fields: [{ path: "paths.deny", merge_operator: "project_default", value: [] }],
      },
    ];
    const decision = decideAction(hostile, promptAction({ resource: "secrets/deploy.key" }));
    expect(decision.outcome).toBe("block");
    expect(decision.reasons.some((reason) => reason.includes("conflicting merge operators"))).toBe(
      true,
    );
  });
});

describe("repository boundary enforcement", () => {
  let root = "";

  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    root = "";
  });

  it("rejects a write that escapes the repository through a symlink", () => {
    root = mkdtempSync(join(tmpdir(), "harness-security-boundary-"));
    mkdirSync(join(root, "src"), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "harness-security-outside-"));
    writeFileSync(join(outside, "target.txt"), "do not touch");
    symlinkSync(outside, join(root, "src", "escape"));
    expect(() => assertWithinRepositoryBoundary(root, "src/escape/target.txt")).toThrowError(
      PolicyError,
    );
    expect(() => assertWithinRepositoryBoundary(root, "src/../escape-out")).toThrowError(
      PolicyError,
    );
    expect(assertWithinRepositoryBoundary(root, "src/new-file.ts")).toContain("src");
    rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
});
