import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { contentDigest, sha256Hex, type PrdProposalDraft } from "@universal-harness-internal/core";
import type { PrdProposalPort } from "@universal-harness-internal/runtime";

import {
  createManagedIntentInterpreter,
  readProjectRuntimeConfig,
  type ManagedIntentInterpreterDeps,
} from "../src/index.js";

const roots: string[] = [];

const PROVIDER_ENTRY = {
  provider_id: "deepseek",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-pro",
  api_key_env: "DEEPSEEK_API_KEY",
  env_allowlist: ["DEEPSEEK_API_KEY"],
  timeout_ms: 60000,
  slots: ["prd_proposal"],
};

const SESSION_CONTEXT = {
  project_profile_digest: "a".repeat(64),
  profile_decision_digest: "b".repeat(64),
  capture_policy_digest: "c".repeat(64),
  project_baseline_digest: "d".repeat(64),
} as const;

const INTENT = "Let users export the monthly report as a CSV file.";

function projectWithConfig(config: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-managed-interpret-")));
  roots.push(root);
  mkdirSync(join(root, ".harness"));
  writeFileSync(join(root, ".harness", "runtime.json"), JSON.stringify(config), "utf8");
  writeFileSync(join(root, "README.md"), "# Demo\nA demo reporting application.\n", "utf8");
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function counterMint(): (kind: string) => string {
  let counter = 0;
  return (kind) => {
    counter += 1;
    return `${kind}_${String(counter)}`;
  };
}

function depsFor(
  root: string,
  overrides: Partial<ManagedIntentInterpreterDeps> = {},
): ManagedIntentInterpreterDeps {
  return {
    projectRoot: root,
    runtimeConfig: readProjectRuntimeConfig(root),
    profile_id: "standard",
    session_context: SESSION_CONTEXT,
    newId: counterMint(),
    environment: { DEEPSEEK_API_KEY: "sk-test" },
    ...overrides,
  };
}

function validDraft(intent: string): PrdProposalDraft {
  const binding = {
    source_kind: "intent" as const,
    source_id: "intent",
    source_digest: contentDigest(intent.normalize("NFC").trim()),
  };
  return {
    schema_version: "1.1.0",
    intent: { text: intent, digest: contentDigest(intent.normalize("NFC").trim()) },
    problem_statement: "Users cannot archive monthly reports outside the application.",
    goals: [
      {
        draft_key: "goal-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "Users can export the monthly report as a CSV file.",
      },
    ],
    non_goals: [],
    actors: [],
    scenarios: [],
    requirements: [
      {
        draft_key: "req-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "The user can export the monthly report as a CSV file.",
        priority: "must",
        change_kind: "must_change",
        scenario_ids: [],
        acceptance_criterion_ids: ["criterion-1"],
      },
    ],
    constraints: [
      {
        draft_key: "constraint-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        statement: "Export must complete within 30 seconds.",
        category: "technical",
        verification_intent: "measure the export duration in an integration test",
      },
    ],
    acceptance_criteria: [
      {
        draft_key: "criterion-1",
        lineage: { kind: "new" },
        proposed_source_bindings: [binding],
        requirement_id: "req-1",
        precondition: "a monthly report exists for the user",
        action: "the user exports the report as CSV",
        observable_outcome: "a CSV file containing the report rows is produced",
        verification_intent: "compare the exported CSV rows with the report data",
        test_first_example:
          "given an existing report, exporting produces a CSV whose rows match the report",
        scenario_kind: "primary",
      },
    ],
    assumptions: [],
    dependencies: [],
    risks: [],
    open_questions: [],
    glossary: [],
    context_source_refs: [],
  };
}

function fetchReturningDraft(draft: PrdProposalDraft, seen: { authorization?: string | null }) {
  const content = JSON.stringify(draft);
  const fetchFake: typeof fetch = (_url, init) => {
    seen.authorization = new Headers(init?.headers).get("authorization");
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    );
  };
  return fetchFake;
}

describe("createManagedIntentInterpreter", () => {
  it("returns undefined when the project declares no model_providers", () => {
    const root = projectWithConfig({ runtime_config_version: 2, gates: [] });
    expect(createManagedIntentInterpreter(depsFor(root))).toBeUndefined();
  });

  it("returns undefined when no declared provider covers the prd_proposal slot", () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [{ ...PROVIDER_ENTRY, slots: ["grounded_synthesis"] }],
    });
    expect(createManagedIntentInterpreter(depsFor(root))).toBeUndefined();
  });

  it("maps a proposed draft onto requirements and constraints, authenticating from the environment", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [PROVIDER_ENTRY],
    });
    const seen: { authorization?: string | null } = {};
    const interpreter = createManagedIntentInterpreter(
      depsFor(root, { fetch: fetchReturningDraft(validDraft(INTENT), seen) }),
    );
    expect(interpreter).toBeDefined();
    const result = await interpreter!(INTENT);
    expect(seen.authorization).toBe("Bearer sk-test");
    expect(result).toEqual({
      requirements: [
        {
          statement: "The user can export the monthly report as a CSV file.",
          acceptance: [
            {
              description:
                "the user exports the report as CSV → a CSV file containing the report rows is produced",
              verification: "compare the exported CSV rows with the report data",
            },
          ],
        },
      ],
      constraints: [
        {
          statement: "Export must complete within 30 seconds.",
          verification: "measure the export duration in an integration test",
        },
      ],
    });
  });

  it("returns undefined for a draft without requirements (no proposal)", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [PROVIDER_ENTRY],
    });
    const draft = { ...validDraft(INTENT), requirements: [], acceptance_criteria: [] };
    const interpreter = createManagedIntentInterpreter(
      depsFor(root, { fetch: fetchReturningDraft(draft, {}) }),
    );
    expect(await interpreter!(INTENT)).toBeUndefined();
  });

  it("throws when the provider keeps failing", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [PROVIDER_ENTRY],
    });
    let attempts = 0;
    const fetchFake: typeof fetch = () => {
      attempts += 1;
      return Promise.resolve(new Response("boom", { status: 500 }));
    };
    const interpreter = createManagedIntentInterpreter(depsFor(root, { fetch: fetchFake }));
    await expect(interpreter!(INTENT)).rejects.toThrowError(/provider_unavailable/u);
    expect(attempts).toBe(3);
  });

  it("maps a clarification request with usable options onto the clarification offer", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [PROVIDER_ENTRY],
    });
    const port: PrdProposalPort = {
      name: "fake-clarifying",
      propose: () => ({
        status: "clarification_required",
        questions: [
          {
            source: "proposal",
            target_kind: "intent",
            missing_dimension: "scope",
            question: "Which reports should be exportable?",
            options: [
              { option_id: "a", label: "Monthly reports only" },
              { option_id: "b", label: "All report kinds" },
            ],
            required: true,
          },
        ],
      }),
    };
    const interpreter = createManagedIntentInterpreter(depsFor(root, { proposal_port: port }));
    const result = await interpreter!(INTENT);
    expect(result).toEqual({
      clarification: [
        {
          subject: "intent",
          question: "Which reports should be exportable?",
          options: ["Monthly reports only", "All report kinds"],
        },
      ],
    });
  });

  it("fails closed when a clarification question lacks usable options", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [PROVIDER_ENTRY],
    });
    const port: PrdProposalPort = {
      name: "fake-clarifying",
      propose: () => ({
        status: "clarification_required",
        questions: [
          {
            source: "proposal",
            target_kind: "intent",
            missing_dimension: "scope",
            question: "Which reports should be exportable?",
            required: true,
          },
        ],
      }),
    };
    const interpreter = createManagedIntentInterpreter(depsFor(root, { proposal_port: port }));
    await expect(interpreter!(INTENT)).rejects.toThrowError(/2-4/u);
  });

  it("fails closed when the port reports a typed failure", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [PROVIDER_ENTRY],
    });
    const port: PrdProposalPort = {
      name: "fake-failing",
      propose: () => ({
        status: "failed",
        failure: { code: "uncertain", summary: "model refused to propose", retryable: false },
      }),
    };
    const interpreter = createManagedIntentInterpreter(depsFor(root, { proposal_port: port }));
    await expect(interpreter!(INTENT)).rejects.toThrowError(/uncertain.*model refused/u);
  });

  it("replays a memoized interpretation for the same intent without re-invoking the provider", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [PROVIDER_ENTRY],
    });
    let calls = 0;
    const countingFetch: typeof fetch = (url, init) => {
      calls += 1;
      return fetchReturningDraft(validDraft(INTENT), {})(url, init);
    };
    const interpreter = createManagedIntentInterpreter(depsFor(root, { fetch: countingFetch }));
    const first = await interpreter!(INTENT);
    const second = await interpreter!(INTENT);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it("fails closed when the capture memo is unreadable", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [PROVIDER_ENTRY],
    });
    const memoDir = join(root, ".harness", "managed-capture");
    mkdirSync(memoDir, { recursive: true });
    writeFileSync(
      join(memoDir, `${sha256Hex(INTENT.normalize("NFC").trim())}.json`),
      "not json",
      "utf8",
    );
    const interpreter = createManagedIntentInterpreter(
      depsFor(root, { fetch: fetchReturningDraft(validDraft(INTENT), {}) }),
    );
    await expect(interpreter!(INTENT)).rejects.toThrowError(/capture memo/u);
  });

  it("never memoizes clarification offers", async () => {
    const root = projectWithConfig({
      runtime_config_version: 2,
      gates: [],
      model_providers: [PROVIDER_ENTRY],
    });
    let proposals = 0;
    const port: PrdProposalPort = {
      name: "fake-clarifying",
      propose: () => {
        proposals += 1;
        return {
          status: "clarification_required",
          questions: [
            {
              source: "proposal",
              target_kind: "intent",
              missing_dimension: "scope",
              question: "Which reports should be exportable?",
              options: [
                { option_id: "a", label: "Monthly reports only" },
                { option_id: "b", label: "All report kinds" },
              ],
              required: true,
            },
          ],
        };
      },
    };
    const interpreter = createManagedIntentInterpreter(depsFor(root, { proposal_port: port }));
    await interpreter!(INTENT);
    await interpreter!(INTENT);
    expect(proposals).toBe(2);
  });
});
