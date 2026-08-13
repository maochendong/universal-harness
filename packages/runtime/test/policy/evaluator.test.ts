import { describe, expect, it } from "vitest";

import { issueGrant } from "../../src/policy/capability-grant.js";
import { policyNumber, policyStrings } from "../../src/policy/decision.js";
import { decideAction, mergePolicyLayers } from "../../src/policy/evaluator.js";

import {
  DELEGATED_PROFILE,
  MANAGED_PROFILE,
  action,
  field,
  grantRequest,
  layer,
} from "./fixtures.js";

describe("mergePolicyLayers", () => {
  it("takes the minimum for hard_ceiling so no lower layer raises the installation ceiling", () => {
    const merged = mergePolicyLayers([
      layer("installation", [field("budgets.max_steps", "hard_ceiling", 100)]),
      layer("pack", [field("budgets.max_steps", "hard_ceiling", 30)]),
      layer("project", [field("budgets.max_steps", "hard_ceiling", 500)]),
    ]);
    expect(merged.conflicts).toEqual([]);
    expect(policyNumber(merged.effective, "budgets.max_steps")).toBe(30);
    const trace = merged.effective.fields[0];
    expect(trace?.reason).toBe("hard_ceiling:min(100,30,500)=30");
    expect(trace?.sources.map((source) => source.layer)).toEqual([
      "installation",
      "pack",
      "project",
    ]);
  });

  it("intersects allow sets and unions deny sets", () => {
    const merged = mergePolicyLayers([
      layer("installation", [
        field("paths.write.allow", "allow_intersection", ["src", "tests", "docs"]),
        field("paths.deny", "deny_union", ["secrets"]),
      ]),
      layer("project", [
        field("paths.write.allow", "allow_intersection", ["src", "scripts"]),
        field("paths.deny", "deny_union", ["secrets", ".git"]),
      ]),
    ]);
    expect(merged.conflicts).toEqual([]);
    expect(policyStrings(merged.effective, "paths.write.allow")).toEqual(["src"]);
    expect(policyStrings(merged.effective, "paths.deny")).toEqual([".git", "secrets"]);
  });

  it("unions approval requirements across layers", () => {
    const merged = mergePolicyLayers([
      layer("pack", [field("approvals.required", "approval_union", ["write_path"])]),
      layer("project", [field("approvals.required", "approval_union", ["risk:high"])]),
    ]);
    expect(policyStrings(merged.effective, "approvals.required")).toEqual([
      "risk:high",
      "write_path",
    ]);
  });

  it("takes the strictest value of a declared strength ordering", () => {
    const merged = mergePolicyLayers([
      layer("pack", [field("controls.trajectory", "strongest_control", "summarized")]),
      layer("project", [field("controls.trajectory", "strongest_control", "external-only")]),
    ]);
    expect(merged.conflicts).toEqual([]);
    const trace = merged.effective.fields[0];
    expect(trace?.value).toBe("summarized");
    expect(trace?.reason).toBe("strongest_control:strictest(summarized,external-only)=summarized");
  });

  it("lets the project value win for project_default fields", () => {
    const merged = mergePolicyLayers([
      layer("pack", [field("style.commit_format", "project_default", "conventional")]),
      layer("project", [field("style.commit_format", "project_default", "freeform")]),
    ]);
    expect(merged.effective.fields[0]?.value).toBe("freeform");
    expect(merged.effective.fields[0]?.reason).toContain("project value wins");
  });

  it("conflicts when a field has no declared merge operator", () => {
    const merged = mergePolicyLayers([
      layer("project", [
        { path: "paths.deny", merge_operator: "override" as never, value: ["src"] },
      ]),
    ]);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]).toContain("unknown merge operator");
    expect(merged.effective.fields).toEqual([]);
  });

  it("conflicts when layers declare different operators for the same field", () => {
    const merged = mergePolicyLayers([
      layer("pack", [field("paths.deny", "deny_union", ["secrets"])]),
      layer("project", [field("paths.deny", "project_default", [])]),
    ]);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]).toContain("conflicting merge operators");
    expect(merged.effective.fields).toEqual([]);
  });

  it("conflicts when a strongest_control value cannot be ordered", () => {
    const merged = mergePolicyLayers([
      layer("project", [field("controls.trajectory", "strongest_control", "lax")]),
    ]);
    expect(merged.conflicts[0]).toContain("cannot be ordered");
    const unknownPath = mergePolicyLayers([
      layer("project", [field("controls.unknown", "strongest_control", "full")]),
    ]);
    expect(unknownPath.conflicts[0]).toContain("no schema-declared strength ordering");
  });

  it("conflicts when a hard_ceiling value is not numeric", () => {
    const merged = mergePolicyLayers([
      layer("project", [field("budgets.max_steps", "hard_ceiling", "lots")]),
    ]);
    expect(merged.conflicts[0]).toContain("requires finite numeric values");
  });

  it("produces a stable effective digest and records every layer digest", () => {
    const layers = [
      layer("installation", [field("budgets.max_steps", "hard_ceiling", 100)], 2),
      layer("pack", [field("budgets.max_steps", "hard_ceiling", 30)]),
    ];
    const first = mergePolicyLayers(layers);
    const second = mergePolicyLayers([...layers].reverse());
    expect(first.effective.digest).toBe(second.effective.digest);
    expect(first.effective.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.effective.layers.map((ref) => ref.layer)).toEqual(["installation", "pack"]);
    expect(first.effective.layers[0]?.revision).toBe(2);
    expect(first.effective.layers[0]?.digest).toBe(layers[0]?.digest);
  });
});

describe("decideAction", () => {
  it("allows an ordinary action inside the effective policy", () => {
    const decision = decideAction(
      [layer("project", [field("paths.read.allow", "allow_intersection", ["src"])])],
      action(),
    );
    expect(decision.outcome).toBe("allow");
    expect(decision.reasons[0]).toContain("allowed");
    expect(decision.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.field_traces.map((trace) => trace.path)).toEqual(["paths.read.allow"]);
  });

  it("is deterministic for the same inputs", () => {
    const layers = [layer("project", [field("paths.read.allow", "allow_intersection", ["src"])])];
    const first = decideAction(layers, action());
    const second = decideAction(layers, action());
    expect(second).toEqual(first);
  });

  it("denies paths in the explicit deny set before any allow is considered", () => {
    const decision = decideAction(
      [
        layer("installation", [
          field("paths.deny", "deny_union", ["secrets"]),
          field("paths.read.allow", "allow_intersection", ["src", "secrets"]),
        ]),
      ],
      action({ resource: "secrets/token.txt", approval_digest: "b".repeat(64) }),
    );
    expect(decision.outcome).toBe("deny");
    expect(decision.reasons[0]).toContain("deny set");
    // The claimed approval never turns a deny into an allow.
    expect(decision.approval_digest).toBeUndefined();
  });

  it("denies traversal paths even when no allow set constrains reads", () => {
    const decision = decideAction([], action({ resource: "../outside.ts" }));
    expect(decision.outcome).toBe("deny");
    expect(decision.reasons[0]).toContain("not a legal repository-relative path");
  });

  it("denies resources in the explicit deny set", () => {
    const decision = decideAction(
      [layer("installation", [field("resources.deny", "deny_union", ["shell_exec"])])],
      action({ kind: "invoke_tool", resource: "shell_exec" }),
    );
    expect(decision.outcome).toBe("deny");
  });

  it("denies capabilities in the explicit deny set", () => {
    const decision = decideAction(
      [layer("installation", [field("capabilities.deny", "deny_union", ["apply_patch"])])],
      action({ kind: "invoke_tool", resource: "apply_patch" }),
    );
    expect(decision.outcome).toBe("deny");
    expect(decision.reasons[0]).toContain("capability");
  });

  it("denies reads and writes outside the allow sets", () => {
    const layers = [
      layer("project", [
        field("paths.read.allow", "allow_intersection", ["src"]),
        field("paths.write.allow", "allow_intersection", ["src/generated"]),
      ]),
    ];
    expect(decideAction(layers, action({ resource: "docs/readme.md" })).outcome).toBe("deny");
    expect(
      decideAction(layers, action({ kind: "write_path", resource: "src/index.ts" })).outcome,
    ).toBe("deny");
    expect(
      decideAction(layers, action({ kind: "write_path", resource: "src/generated/api.ts" }))
        .outcome,
    ).toBe("allow");
  });

  it("denies tools outside the resource allow set and actions outside allowed phases", () => {
    const layers = [
      layer("project", [
        field("resources.allow", "allow_intersection", ["apply_patch"]),
        field("phases.allow", "allow_intersection", ["implementation", "verification"]),
      ]),
    ];
    expect(
      decideAction(layers, action({ kind: "invoke_tool", resource: "shell_exec" })).outcome,
    ).toBe("deny");
    expect(decideAction(layers, action({ phase: "release" })).outcome).toBe("deny");
    expect(decideAction(layers, action({ phase: "verification" })).outcome).toBe("allow");
  });

  it("requires approval for declared kinds and risk thresholds", () => {
    const layers = [
      layer("pack", [field("approvals.required", "approval_union", ["write_path", "risk:high"])]),
    ];
    const write = decideAction(layers, action({ kind: "write_path", resource: "src/index.ts" }));
    expect(write.outcome).toBe("requires_approval");
    const risky = decideAction(layers, action({ risk: "high" }));
    expect(risky.outcome).toBe("requires_approval");
    const calm = decideAction(layers, action({ risk: "medium" }));
    expect(calm.outcome).toBe("allow");
  });

  it("lets a bound approval satisfy requires-approval", () => {
    const layers = [layer("pack", [field("approvals.required", "approval_union", ["write_path"])])];
    const digest = "c".repeat(64);
    const decision = decideAction(
      layers,
      action({ kind: "write_path", resource: "src/index.ts", approval_digest: digest }),
    );
    expect(decision.outcome).toBe("allow");
    expect(decision.approval_digest).toBe(digest);
  });

  it("ignores approvals the active grant does not bind", () => {
    const layers = [layer("pack", [field("approvals.required", "approval_union", ["write_path"])])];
    const merged = mergePolicyLayers(layers);
    const grant = issueGrant(
      grantRequest({ approval_digests: ["d".repeat(64)] }),
      merged.effective,
    );
    const decision = decideAction(
      layers,
      action({ kind: "write_path", resource: "src/index.ts", approval_digest: "e".repeat(64) }),
      grant,
    );
    expect(decision.outcome).toBe("requires_approval");
  });

  it("denies adapters that cannot provide the required trajectory evidence", () => {
    const layers = [
      layer("installation", [field("controls.trajectory", "strongest_control", "full")]),
    ];
    expect(decideAction(layers, action({ control_profile: DELEGATED_PROFILE })).outcome).toBe(
      "deny",
    );
    expect(decideAction(layers, action()).outcome).toBe("deny");
    expect(decideAction(layers, action({ control_profile: MANAGED_PROFILE })).outcome).toBe(
      "allow",
    );
  });

  it("denies adapters that cannot intercept side effects when policy requires it", () => {
    const layers = [
      layer("project", [
        field("controls.side_effect_interception", "strongest_control", "required"),
      ]),
    ];
    expect(decideAction(layers, action({ control_profile: DELEGATED_PROFILE })).outcome).toBe(
      "deny",
    );
    expect(decideAction(layers, action({ control_profile: MANAGED_PROFILE })).outcome).toBe(
      "allow",
    );
  });

  it("denies prompt-carried escalation regardless of any allow set", () => {
    const layers = [layer("project", [field("paths.write.allow", "allow_intersection", ["src"])])];
    for (const kind of [
      "change_policy",
      "register_tool",
      "grant_path",
      "approve",
      "accept_evidence",
    ] as const) {
      const decision = decideAction(layers, action({ kind, resource: undefined }));
      expect(decision.outcome).toBe("deny");
      expect(decision.reasons[0]).toContain("untrusted context");
    }
  });

  it("denies escalation by agent or adapter identity even from the control plane", () => {
    for (const actorKind of ["agent", "adapter"] as const) {
      const decision = decideAction(
        [],
        action({ kind: "approve", actor_kind: actorKind, origin: "control_plane" }),
      );
      expect(decision.outcome).toBe("deny");
      expect(decision.reasons[0]).toContain(`${actorKind} identity never authorizes`);
    }
  });

  it("allows control-plane escalation for harness and human actors", () => {
    expect(
      decideAction(
        [],
        action({ kind: "change_policy", actor_kind: "harness", origin: "control_plane" }),
      ).outcome,
    ).toBe("allow");
    expect(
      decideAction([], action({ kind: "approve", actor_kind: "human", origin: "control_plane" }))
        .outcome,
    ).toBe("allow");
  });

  it("blocks on policy conflict and records the conflict plus every layer digest", () => {
    const layers = [
      layer("installation", [field("paths.deny", "deny_union", ["secrets"])], 3),
      layer("project", [field("paths.deny", "project_default", [])]),
    ];
    const decision = decideAction(layers, action());
    expect(decision.outcome).toBe("block");
    expect(decision.reasons.some((reason) => reason.includes("conflicting merge operators"))).toBe(
      true,
    );
    expect(decision.layers.map((ref) => ref.layer)).toEqual(["installation", "project"]);
    expect(decision.effective_policy_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces the active capability grant", () => {
    const layers = [
      layer("project", [
        field("paths.read.allow", "allow_intersection", ["src", "docs"]),
        field("paths.write.allow", "allow_intersection", ["src"]),
        field("resources.allow", "allow_intersection", ["apply_patch"]),
      ]),
    ];
    const merged = mergePolicyLayers(layers);
    const grant = issueGrant(
      grantRequest({
        tools: [{ name: "apply_patch", parameter_bounds: { mode: ["dry-run", "apply"] } }],
      }),
      merged.effective,
    );
    // Inside the grant: allowed.
    expect(decideAction(layers, action({ resource: "src/index.ts" }), grant).outcome).toBe("allow");
    // The grant narrows the policy: docs is allowed by policy but not granted.
    const outside = decideAction(layers, action({ resource: "docs/readme.md" }), grant);
    expect(outside.outcome).toBe("deny");
    expect(outside.reasons[0]).toContain("outside the granted read scope");
    // Phase mismatch.
    expect(decideAction(layers, action({ phase: "release" }), grant).outcome).toBe("deny");
    // Ungranted tool.
    expect(
      decideAction(layers, action({ kind: "invoke_tool", resource: "shell_exec" }), grant).outcome,
    ).toBe("deny");
    // Parameter outside the granted bounds.
    const widened = decideAction(
      layers,
      action({ kind: "invoke_tool", resource: "apply_patch", parameters: { mode: "force" } }),
      grant,
    );
    expect(widened.outcome).toBe("deny");
    expect(widened.reasons[0]).toContain("parameter bounds");
    // Parameter inside the granted bounds.
    expect(
      decideAction(
        layers,
        action({ kind: "invoke_tool", resource: "apply_patch", parameters: { mode: "apply" } }),
        grant,
      ).outcome,
    ).toBe("allow");
    // State proposals outside the granted fields.
    expect(
      decideAction(layers, action({ kind: "propose_state", resource: "budget" }), grant).outcome,
    ).toBe("deny");
    expect(
      decideAction(layers, action({ kind: "propose_state", resource: "hypotheses" }), grant)
        .outcome,
    ).toBe("allow");
  });

  it("denies actions carrying a grant bound to a stale effective policy digest", () => {
    const first = mergePolicyLayers([
      layer("project", [field("paths.read.allow", "allow_intersection", ["src"])]),
    ]);
    const grant = issueGrant(grantRequest(), first.effective);
    const changed = [
      layer("project", [field("paths.read.allow", "allow_intersection", ["src", "docs"])]),
    ];
    const decision = decideAction(changed, action(), grant);
    expect(decision.outcome).toBe("deny");
    expect(decision.reasons[0]).toContain("stale");
  });
});
