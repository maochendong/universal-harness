import { describe, expect, it } from "vitest";

import { PolicyError } from "../../src/policy/action.js";
import { grantDenialReason, issueGrant, narrowGrant } from "../../src/policy/capability-grant.js";
import { mergePolicyLayers } from "../../src/policy/evaluator.js";

import { action, field, grantRequest, layer } from "./fixtures.js";

function effectiveWith(fields: readonly ReturnType<typeof field>[]) {
  return mergePolicyLayers([layer("project", fields)]).effective;
}

describe("issueGrant", () => {
  it("issues a deterministic grant as a narrowing of the effective policy", () => {
    const effective = effectiveWith([
      field("capabilities.allow", "allow_intersection", ["edit-source", "run-tests"]),
      field("paths.read.allow", "allow_intersection", ["src", "docs"]),
      field("paths.write.allow", "allow_intersection", ["src"]),
      field("resources.allow", "allow_intersection", ["apply_patch"]),
      field("phases.allow", "allow_intersection", ["implementation"]),
    ]);
    const grant = issueGrant(grantRequest(), effective);
    expect(grant.issued_by).toBe("harness");
    expect(grant.effective_policy_digest).toBe(effective.digest);
    expect(grant.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(issueGrant(grantRequest(), effective)).toEqual(grant);
  });

  it("normalizes path sets into canonical repository-relative form", () => {
    const grant = issueGrant(
      grantRequest({ read_paths: ["src\\nested", "./src", "src/nested"], write_paths: ["src"] }),
      effectiveWith([]),
    );
    expect(grant.read_paths).toEqual(["src", "src/nested"]);
  });

  it("rejects capabilities outside the allow set or in the deny set", () => {
    const effective = effectiveWith([
      field("capabilities.allow", "allow_intersection", ["edit-source"]),
      field("capabilities.deny", "deny_union", ["deploy"]),
    ]);
    expect(() =>
      issueGrant(grantRequest({ capabilities: ["edit-source", "run-tests"] }), effective),
    ).toThrowError(PolicyError);
    expect(() => issueGrant(grantRequest({ capabilities: ["deploy"] }), effective)).toThrowError(
      PolicyError,
    );
  });

  it("rejects read and write paths outside the allow sets and denied write paths", () => {
    const effective = effectiveWith([
      field("paths.read.allow", "allow_intersection", ["src"]),
      field("paths.write.allow", "allow_intersection", ["src"]),
      field("paths.deny", "deny_union", ["src/secrets"]),
    ]);
    expect(() => issueGrant(grantRequest({ read_paths: ["docs"] }), effective)).toThrowError(
      PolicyError,
    );
    expect(() => issueGrant(grantRequest({ write_paths: ["docs"] }), effective)).toThrowError(
      PolicyError,
    );
    expect(() =>
      issueGrant(grantRequest({ write_paths: ["src/secrets"] }), effective),
    ).toThrowError(PolicyError);
    expect(() =>
      issueGrant(grantRequest({ write_paths: ["src/nested"] }), effective),
    ).not.toThrow();
  });

  it("rejects tools outside the resource allow set and phases outside the phase allow set", () => {
    const effective = effectiveWith([
      field("resources.allow", "allow_intersection", ["apply_patch"]),
      field("phases.allow", "allow_intersection", ["implementation"]),
    ]);
    expect(() =>
      issueGrant(grantRequest({ tools: [{ name: "shell_exec" }] }), effective),
    ).toThrowError(PolicyError);
    expect(() => issueGrant(grantRequest({ phase: "release" }), effective)).toThrowError(
      PolicyError,
    );
  });

  it("clamps budgets down to hard ceilings without needing approval", () => {
    const effective = effectiveWith([
      field("budgets.max_steps", "hard_ceiling", 10),
      field("budgets.max_tokens", "hard_ceiling", 40000),
    ]);
    const grant = issueGrant(grantRequest({ budget: { steps: 20, tokens: 50000 } }), effective);
    expect(grant.budget).toEqual({ steps: 10, tokens: 40000 });
    const lower = issueGrant(grantRequest({ budget: { steps: 5, tokens: 1000 } }), effective);
    expect(lower.budget).toEqual({ steps: 5, tokens: 1000 });
  });
});

describe("narrowGrant", () => {
  const effective = effectiveWith([]);

  it("narrows sets and budgets and produces a fresh digest", () => {
    const grant = issueGrant(
      grantRequest({ capabilities: ["edit-source", "run-tests"], read_paths: ["src", "docs"] }),
      effective,
    );
    const narrowed = narrowGrant(grant, {
      capabilities: ["edit-source"],
      read_paths: ["src"],
      budget: { steps: 5, tokens: 1000 },
    });
    expect(narrowed.capabilities).toEqual(["edit-source"]);
    expect(narrowed.read_paths).toEqual(["src"]);
    expect(narrowed.budget).toEqual({ steps: 5, tokens: 1000 });
    expect(narrowed.digest).not.toBe(grant.digest);
    // The original grant is unchanged.
    expect(grant.capabilities).toEqual(["edit-source", "run-tests"]);
    expect(grant.budget).toEqual({ steps: 20, tokens: 50000 });
  });

  it("never widens capabilities, paths, state fields or budgets", () => {
    const grant = issueGrant(grantRequest(), effective);
    expect(() => narrowGrant(grant, { capabilities: ["edit-source", "deploy"] })).toThrowError(
      PolicyError,
    );
    expect(() => narrowGrant(grant, { read_paths: ["src", "docs"] })).toThrowError(PolicyError);
    expect(() => narrowGrant(grant, { write_paths: ["docs"] })).toThrowError(PolicyError);
    expect(() => narrowGrant(grant, { state_fields: ["hypotheses", "budget"] })).toThrowError(
      PolicyError,
    );
    expect(() => narrowGrant(grant, { budget: { steps: 21, tokens: 50000 } })).toThrowError(
      PolicyError,
    );
    expect(() => narrowGrant(grant, { budget: { steps: 20, tokens: 50001 } })).toThrowError(
      PolicyError,
    );
  });

  it("never adds tools and never loosens parameter bounds", () => {
    const grant = issueGrant(
      grantRequest({
        tools: [{ name: "apply_patch", parameter_bounds: { mode: ["dry-run", "apply"] } }],
      }),
      effective,
    );
    expect(() =>
      narrowGrant(grant, {
        tools: [
          { name: "apply_patch", parameter_bounds: { mode: ["dry-run", "apply"] } },
          { name: "shell_exec" },
        ],
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      narrowGrant(grant, {
        tools: [{ name: "apply_patch", parameter_bounds: { mode: ["dry-run", "apply", "force"] } }],
      }),
    ).toThrowError(PolicyError);
    // Tighter bounds are narrowing and allowed.
    const tighter = narrowGrant(grant, {
      tools: [{ name: "apply_patch", parameter_bounds: { mode: ["dry-run"] } }],
    });
    expect(tighter.tools[0]?.parameter_bounds?.mode).toEqual(["dry-run"]);
  });
});

describe("grantDenialReason", () => {
  it("reports the phase, scope and tool violations a grant enforces", () => {
    const grant = issueGrant(grantRequest(), effectiveWith([]));
    expect(grantDenialReason(grant, action())).toBeUndefined();
    expect(grantDenialReason(grant, action({ phase: "release" }))).toContain("phase");
    expect(grantDenialReason(grant, action({ resource: "docs/readme.md" }))).toContain(
      "read scope",
    );
    expect(
      grantDenialReason(grant, action({ kind: "write_path", resource: "docs/x.md" })),
    ).toContain("write scope");
    expect(
      grantDenialReason(grant, action({ kind: "propose_state", resource: "budget" })),
    ).toContain("state proposal scope");
    expect(
      grantDenialReason(grant, action({ kind: "invoke_tool", resource: "shell_exec" })),
    ).toContain("not in the granted tool set");
  });
});
