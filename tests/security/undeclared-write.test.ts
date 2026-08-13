import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { harnessRootFor, resolveHarnessPath } from "../../packages/core/src/index.js";
import type { AgentRunResult } from "../../packages/plugin-sdk/src/index.js";
import {
  ProjectionError,
  createDefaultEvaluationPort,
  decideAction,
  issueGrant,
  mergePolicyLayers,
  normalizeAction,
  planManagedWrite,
  writeManagedOutput,
  type PolicyLayerInput,
} from "../../packages/runtime/src/index.js";

/**
 * Undeclared-write detection (design 13.2/13.7; security test list). A write
 * the task never declared is caught at three independent layers: the policy
 * evaluator denies it before execution, the managed projection writer refuses
 * to overwrite foreign bytes without an explicit approval, and the run
 * evaluation fails any run whose adapter reports undeclared writes.
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
      { path: "budgets.max_steps", merge_operator: "hard_ceiling", value: 30 },
    ],
  },
  {
    layer: "project",
    revision: 2,
    digest: "b".repeat(64),
    fields: [
      { path: "paths.write.allow", merge_operator: "allow_intersection", value: ["src"] },
      { path: "resources.allow", merge_operator: "allow_intersection", value: ["apply_patch"] },
    ],
  },
];

function taskGrant() {
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
      budget: { steps: 10, tokens: 1000 },
      approval_digests: [],
    },
    merged.effective,
  );
}

function writeAction(resource: string) {
  return normalizeAction({
    kind: "write_path",
    actor: "adapter_01",
    actor_kind: "adapter",
    origin: "control_plane",
    phase: "implementation",
    parameters: {},
    risk: "low",
    resource,
    control_profile: MANAGED_PROFILE,
  });
}

describe("policy-layer undeclared writes", () => {
  it("denies writes outside the granted scope, wherever they land", () => {
    const grant = taskGrant();
    const undeclared = [
      ".github/workflows/pwn.yml",
      "docs/readme.md",
      "package.json",
      "src/../../outside.txt",
    ];
    for (const resource of undeclared) {
      const decision = decideAction(LAYERS, writeAction(resource), grant);
      expect(decision.outcome, resource).toBe("deny");
    }
    const declared = decideAction(LAYERS, writeAction("src/feature.ts"), grant);
    expect(declared.outcome).toBe("allow");
  });
});

describe("managed projection writes", () => {
  const created: string[] = [];

  function makeHarnessRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-undeclared-")));
    created.push(root);
    return harnessRootFor(root);
  }

  afterEach(() => {
    while (created.length > 0) {
      const directory = created.pop();
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite foreign bytes without an explicit approval", () => {
    const harnessRoot = makeHarnessRoot();
    const target = resolveHarnessPath(harnessRoot, "projections/views/prd.md");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "hand-edited user content", "utf8");

    const output = { name: "views/prd.md", content: "generated projection" };
    const plan = planManagedWrite(harnessRoot, output);
    expect(plan.action).toBe("rewrite");
    expect(() => writeManagedOutput(harnessRoot, output)).toThrowError(ProjectionError);
    // The refused write changed nothing on disk.
    expect(readFileSync(target, "utf8")).toBe("hand-edited user content");
    // With the approval, the same write proceeds and reports the rewrite.
    const approved = writeManagedOutput(harnessRoot, output, { overwriteApproved: true });
    expect(approved.action).toBe("rewrite");
    expect(readFileSync(target, "utf8")).toBe("generated projection");
  });

  it("writes inside the managed root are create/noop classified", () => {
    const harnessRoot = makeHarnessRoot();
    const output = { name: "views/architecture.md", content: "generated" };
    expect(planManagedWrite(harnessRoot, output).action).toBe("create");
    writeManagedOutput(harnessRoot, output);
    expect(planManagedWrite(harnessRoot, output).action).toBe("noop");
  });
});

describe("run evaluation undeclared-write detection", () => {
  function runResult(undeclaredWrites: string[]): AgentRunResult {
    return {
      outcome: "handoff",
      termination_reason: "completion",
      completion_claimed: true,
      summary: "run finished",
      state_proposal: null,
      dropped_proposal_fields: [],
      change_summary: { files_changed: 1, insertions: 5, deletions: 0, paths: ["src/feature.ts"] },
      tool_activity: { total_calls: 1, governed_calls: 1, by_tool: { apply_patch: 1 } },
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        duration_ms: 10,
        metering: "unmetered",
      },
      evidence: [],
      undeclared_writes: undeclaredWrites,
    };
  }

  const input = {
    taskId: "task_undeclared",
    iterationId: "iteration_01",
    visibility: "full" as const,
    budget: { max_steps: 10, max_tokens: 1000, max_duration_ms: 60_000 },
    now: "2026-08-12T00:00:00.000Z",
  };

  it("fails a run whose adapter reports undeclared writes", async () => {
    const evaluation = createDefaultEvaluationPort();
    const result = await evaluation({
      ...input,
      run: runResult([".github/workflows/pwn.yml"]),
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toContain(".github/workflows/pwn.yml");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.summary).toContain("undeclared writes");
  });

  it("passes a run with every write declared", async () => {
    const evaluation = createDefaultEvaluationPort();
    const result = await evaluation({ ...input, run: runResult([]) });
    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
});
