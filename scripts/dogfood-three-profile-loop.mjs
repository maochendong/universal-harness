#!/usr/bin/env node
/**
 * Full-remediation dogfood: install the packed CLI into a clean host and run
 * one authoritative vertical loop for Lite, Standard and Governed. The
 * hermetic mode uses a host-owned trusted Provider/fetch seam; `--real` uses
 * the built-in DeepSeek trust entry and never persists credential values.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_FLAG = "--installed-host";
// Windows exposes pnpm/npm only as .cmd shims. Since Node 20.12
// (CVE-2024-27980) spawning a .cmd without a shell throws EINVAL, so Windows
// must go through cmd.exe.
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NEEDS_SHELL = process.platform === "win32";
const MODEL_SLOTS = [
  "prd_proposal",
  "prd_review",
  "project_discovery",
  "approval_brief",
  "design_proposal",
  "design_review",
  "impact_advisory",
  "plan_proposal",
  "context_enrichment",
  "iteration_narrative",
];

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function digestValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function latest(records) {
  return records
    .toSorted((left, right) =>
      String(left.created_at ?? left.sequence ?? "").localeCompare(
        String(right.created_at ?? right.sequence ?? ""),
      ),
    )
    .at(-1);
}

function recordsBelow(projectRoot, relative) {
  return filesBelow(join(projectRoot, ".harness", relative))
    .filter((path) => path.endsWith(".json"))
    .map(readJson);
}

function extractPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const contract = messages.map((entry) => String(entry.content ?? "")).join("\n");
  const schema = /registered output schema "([^"]+)"/u.exec(contract)?.[1];
  const user = messages.find((entry) => entry.role === "user")?.content ?? "";
  const items = new Map();
  const pattern =
    /<untrusted-item source-id="([^"]+)" source-kind="([^"]+)" digest="[a-f0-9]{64}">\n([\s\S]*?)\n<\/untrusted-item>/gu;
  for (const match of String(user).matchAll(pattern)) {
    const text = match[3] ?? "";
    let value = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Intent and source documents are deliberately plain text.
    }
    items.set(match[1], { kind: match[2], value });
  }
  if (schema === undefined) throw new Error("fake Provider could not identify output schema");
  return { schema, items };
}

const sourceBinding = (digest) => ({
  source_kind: "intent",
  source_id: "intent",
  source_digest: digest,
});

function proposalDraft(items) {
  const intent = String(items.get("intent")?.value ?? "");
  const binding = items.get("session-binding")?.value;
  const digest = binding.intent_digest;
  const source = [sourceBinding(digest)];
  return {
    schema_version: "1.1.0",
    intent: { text: intent, digest },
    problem_statement: intent,
    goals: [
      {
        draft_key: "goal-1",
        lineage: { kind: "new" },
        proposed_source_bindings: source,
        statement: "Complete the requested change through an auditable Harness loop.",
      },
    ],
    non_goals: [],
    actors: [
      {
        draft_key: "actor-1",
        lineage: { kind: "new" },
        proposed_source_bindings: source,
        name: "Harness operator",
        description: "Runs and reviews the governed dogfood iteration.",
      },
    ],
    scenarios: [
      {
        draft_key: "scenario-primary",
        lineage: { kind: "new" },
        proposed_source_bindings: source,
        actor_id: "actor-1",
        precondition: "The managed project and trusted Provider are configured.",
        action: "The operator starts the dogfood iteration.",
        observable_outcome: "The iteration reaches a completed Snapshot.",
        scenario_kind: "primary",
      },
      {
        draft_key: "scenario-failure",
        lineage: { kind: "new" },
        proposed_source_bindings: source,
        actor_id: "actor-1",
        precondition: "A mandatory gate fails.",
        action: "The Harness evaluates the gate result.",
        observable_outcome: "The iteration blocks without claiming completion.",
        scenario_kind: "failure",
      },
    ],
    requirements: [
      {
        draft_key: "requirement-1",
        lineage: { kind: "new" },
        proposed_source_bindings: source,
        statement: intent,
        priority: "must",
        change_kind: "must_change",
        scenario_ids: ["scenario-primary", "scenario-failure"],
        acceptance_criterion_ids: ["criterion-1", "criterion-2"],
      },
    ],
    constraints: [],
    acceptance_criteria: [
      {
        draft_key: "criterion-1",
        lineage: { kind: "new" },
        proposed_source_bindings: source,
        requirement_id: "requirement-1",
        precondition: "The managed project is initialized.",
        action: "The requested no-op dogfood task is executed.",
        observable_outcome: "The mechanical verification gate passes.",
        verification_intent: "Run the configured deterministic gate.",
        test_first_example: "The gate initially represents the executable acceptance assertion.",
        scenario_kind: "primary",
      },
      {
        draft_key: "criterion-2",
        lineage: { kind: "new" },
        proposed_source_bindings: source,
        requirement_id: "requirement-1",
        precondition: "The deterministic gate reports failure.",
        action: "The Harness verifies the requested task.",
        observable_outcome: "The iteration remains blocked.",
        verification_intent: "Run a failing gate fixture and inspect terminal state.",
        test_first_example: "A failing mandatory gate prevents Snapshot completion.",
        scenario_kind: "failure",
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

function designProposal(input, profile) {
  const requirementId = input.must_change_requirement_ids[0];
  const suffix = requirementId.replace(/^[a-z][a-z0-9-]*_/u, "").slice(0, 24);
  const decisionId = `decision_dogfood-${suffix}`;
  const nodeChanges = [
    {
      action: "create",
      node_id: decisionId,
      node_type: "Decision",
      target_revision: 1,
      proposed_extensions: {
        "harness.design.decision": {
          title: "Use a deterministic no-op implementation for dogfood",
          summary: "Exercise governance without changing project source files.",
        },
      },
    },
  ];
  const edgeChanges = [
    {
      action: "create",
      edge_id: `edge_dogfood-addresses-${suffix}`,
      relation: "ADDRESSES",
      source_id: decisionId,
      target_id: requirementId,
      reason: "The decision directly addresses the dogfood requirement.",
    },
  ];
  const coverage = {
    requirement_id: requirementId,
    decision_ids: [decisionId],
    component_scope: {
      status: "not_applicable",
      reason: "The dogfood task intentionally changes no product component.",
    },
    test_strategy_coverage: [],
    supporting_test_strategy_ids: [],
    applicability: {
      api: { status: "not_applicable", reason: "No API contract changes." },
      data: { status: "not_applicable", reason: "No data contract changes." },
      ui: { status: "not_applicable", reason: "No UI design changes." },
    },
  };
  for (const [index, pair] of input.criterion_test_pairs.entries()) {
    const strategyId = `designartifact_dogfood-${suffix}-${String(index + 1)}`;
    nodeChanges.push({
      action: "create",
      node_id: strategyId,
      node_type: "DesignArtifact",
      target_revision: 1,
      proposed_extensions: {
        "harness.design.artifact": {
          artifact_kind: "test_strategy",
          title: "Mechanical dogfood verification strategy",
          summary: "Use the configured gate as objective evidence.",
          assumptions: ["The task intentionally changes no executable production behavior."],
          acceptance_implications: ["The deterministic gate must pass."],
          body_format: "structured",
          body: {
            scenarios: ["Run the full managed loop."],
            test_levels: ["end-to-end"],
            required_gates: profile === "governed" ? ["gate_dogfood"] : [],
            required_evidence: ["gate_evidence"],
            tdd: [
              {
                requirement_id: requirementId,
                applicability:
                  profile === "governed"
                    ? {
                        status: "required",
                        baseline_guard_gates: ["gate_dogfood"],
                        target_gate: "gate_dogfood",
                        test_selectors: ["tests/dogfood.test.ts"],
                        failure_oracle:
                          "the accepted dogfood assertion fails before implementation",
                        path_policy: {
                          test: ["tests/**"],
                          test_config: [],
                          production: ["src/**"],
                          immutable: [".harness/**"],
                        },
                        framework_profile_digest: "f".repeat(64),
                        refactor_policy: "not_planned",
                      }
                    : {
                        status: "not_applicable",
                        category: "non_executable_projection",
                        reason:
                          "The Standard dogfood operation validates orchestration evidence without executable product behavior.",
                      },
              },
            ],
          },
        },
      },
    });
    edgeChanges.push({
      action: "create",
      edge_id: `edge_dogfood-specifies-${suffix}-${String(index + 1)}`,
      relation: "SPECIFIES",
      source_id: strategyId,
      target_id: pair.test_node_id,
      reason: "The strategy is the primary verifier for the accepted criterion.",
    });
    coverage.test_strategy_coverage.push({
      acceptance_criterion_id: pair.acceptance_criterion_id,
      test_node_id: pair.test_node_id,
      primary_test_strategy_id: strategyId,
    });
    coverage.supporting_test_strategy_ids.push(strategyId);
  }
  return {
    purpose: "design_proposal",
    schema_version: "design_proposal.v1",
    proposal: {
      requirement_baseline_digest: input.requirement_baseline_digest,
      impact_set_id: input.impact_set_id,
      impact_set_digest: input.impact_set_digest,
      policy_digest: input.policy_digest,
      repository_baseline: input.repository_baseline,
      mode: "change",
      node_changes: nodeChanges,
      reused_assets: [],
      edge_changes: edgeChanges,
      coverage: [coverage],
      risk_summary: { level: "medium", reasons: ["The design creates governed assets."] },
      rationale: "A minimal evidence-only design proves the complete orchestration loop.",
    },
    questions: [],
  };
}

function fakeOutput(schema, items, profile) {
  switch (schema) {
    case "prd-proposal-draft":
      return proposalDraft(items);
    case "prd-review-report-draft": {
      const rubric = items.get("review-rubric")?.value;
      const dimensions = (rubric.dimensions ?? rubric.dimension_ids ?? []).map((entry) => ({
        dimension_id: typeof entry === "string" ? entry : entry.dimension_id,
        status: "satisfied",
        notes: "Satisfied by the complete dogfood proposal.",
      }));
      return { verdict: "accept", dimensions, findings: [], suggested_questions: [] };
    }
    case "project-discovery-output": {
      const input = items.get("synthesis-input")?.value;
      return {
        purpose: "project_discovery",
        schema_version: "project-discovery.v1",
        bundle_digest: input.bundle,
        facts: [],
        capability_candidates: [],
        gate_candidates: [],
      };
    }
    case "approval-brief-output": {
      const input = items.get("synthesis-input")?.value;
      return {
        purpose: "approval_brief",
        schema_version: "approval-brief.v1",
        bundle_digest: input.bundle,
        changes: [],
        risks: [],
        tradeoffs: [],
        open_questions: [],
      };
    }
    case "context-enrichment-output": {
      const input = items.get("synthesis-input")?.value;
      return {
        purpose: "context_enrichment",
        schema_version: "context-enrichment.v1",
        bundle_digest: input.bundle,
        terms: [],
        segment_summaries: [],
        relevance_explanations: [],
      };
    }
    case "iteration-narrative-output": {
      const input = items.get("synthesis-input")?.value;
      return {
        purpose: "iteration_narrative",
        schema_version: "iteration-narrative.v1",
        bundle_digest: input.bundle,
        outcomes: [],
        residual_risks: [],
        follow_ups: [],
      };
    }
    case "impact-advisory-output": {
      const input = items.get("impact-advisory-input")?.value;
      return {
        purpose: "impact_advisory",
        schema_version: "impact-advisory.v1",
        impact_set_digest: input.impact_set_digest,
        additions: [],
        edge_candidates: [],
        risk_signals: [],
        missing_facts: [],
        questions: [],
      };
    }
    case "design-proposal-output":
      return designProposal(items.get("design-proposal-input")?.value, profile);
    case "design-review-output": {
      const input = items.get("design-review-input")?.value;
      return {
        purpose: "design_review",
        schema_version: "design_review.v1",
        verdict: "accept_recommended",
        findings: [],
        coverage_assessment: input.must_change_requirement_ids.map((requirement_id) => ({
          requirement_id,
          status: "covered",
        })),
        residual_risks: [],
        summary: "The minimal design is fully traceable and mechanically verifiable.",
      };
    }
    case "plan-proposal-output": {
      const input = items.get("plan-proposal-input")?.value;
      return {
        purpose: "plan_proposal",
        schema_version: "plan_proposal.v1",
        tasks: input.canonical_assertions.map((assertion, index) => ({
          task_key: `dogfood-task-${String(index + 1)}`,
          goal: `Prove accepted dogfood assertion ${assertion.assertion_id}.`,
          atomicity_rationale:
            "One Task owns one Criterion Assertion and its single primary test strategy.",
          assertion_ids: [assertion.assertion_id],
          requirement_ids: [assertion.requirement_id],
          decision_ids: input.known_decision_ids,
          design_artifact_ids:
            assertion.primary_test_strategy_id === undefined
              ? []
              : [assertion.primary_test_strategy_id],
          depends_on: [],
          suggested_gate_ids: input.known_gate_ids.slice(0, 1),
          suggested_write_paths: [],
        })),
        questions: [],
      };
    }
    default:
      throw new Error(`fake Provider has no output fixture for ${schema}`);
  }
}

function fakeRegistry() {
  const resolved = {
    provider_ref: "dogfood",
    provider_identity: "dogfood-fake-provider",
    endpoint: "https://dogfood.invalid/v1/chat/completions",
    api_key_env: "HARNESS_DOGFOOD_KEY",
    env_allowlist: ["HARNESS_DOGFOOD_KEY"],
    allow_loopback_http: false,
    policy_digest: "9".repeat(64),
  };
  return {
    resolve({ provider_ref, consumer }) {
      if (provider_ref !== "dogfood" || !["managed_model", "llm_judge"].includes(consumer)) {
        throw new Error("untrusted dogfood Provider reference");
      }
      return resolved;
    },
    matchLegacy() {
      throw new Error("legacy Provider configuration is forbidden in dogfood");
    },
  };
}

async function fakeFetch(_input, init, profile) {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const prompt = extractPrompt(body);
  const output = fakeOutput(prompt.schema, prompt.items, profile);
  return new globalThis.Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function writeAgentScript(path) {
  writeFileSync(
    path,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("dogfood-dsh 1.0.0"); } else { console.log("deterministic command agent completed the evidence-only task"); }\n`,
    "utf8",
  );
}

function writeRuntimeConfig(projectRoot, profile, providerMode, agentScript) {
  const configPath = join(projectRoot, ".harness", "runtime.json");
  const config = readJson(configPath);
  // Command gates are spawned with shell:false. On POSIX a committed shell
  // script runs directly; on Windows CreateProcess cannot execute scripts and
  // .cmd shims throw EINVAL since Node 20.12, so the sandbox gets its own
  // Node binary (hardlink, copy as fallback -- official Windows Node builds
  // are statically linked, unlike shared POSIX builds) that runs the gate
  // script. The binary is gitignored so the worktree stays clean.
  const isWindows = process.platform === "win32";
  const gateFile = isWindows ? "dogfood-gate.mjs" : "dogfood-gate.sh";
  const gatePath = join(projectRoot, "scripts", gateFile);
  mkdirSync(dirname(gatePath), { recursive: true });
  let gateExecutable;
  let gateArgs;
  if (isWindows) {
    writeFileSync(gatePath, "// deterministic dogfood gate: always pass\n", "utf8");
    gateExecutable = "scripts/dogfood-node.exe";
    gateArgs = [`scripts/${gateFile}`];
    try {
      linkSync(process.execPath, join(projectRoot, gateExecutable));
    } catch {
      copyFileSync(process.execPath, join(projectRoot, gateExecutable));
    }
    appendFileSync(join(projectRoot, ".gitignore"), `${gateExecutable}\n`, "utf8");
  } else {
    writeFileSync(gatePath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(gatePath, 0o755);
    gateExecutable = `scripts/${gateFile}`;
    gateArgs = [];
  }
  config.runtime_config_version = 3;
  config.agent = {
    provider: "dsh",
    expected_version: "dogfood-dsh 1.0.0",
    executable: process.execPath,
    launcher_args: [agentScript],
    env_allowlist: ["HOME", "LANG", "PATH", "TMPDIR"],
    allowed_read_paths: [],
    proposed_write_paths: [],
  };
  config.gates = [
    {
      gate_id: "gate_dogfood",
      name: "Dogfood deterministic gate",
      mandatory: true,
      subject_id: "test_dogfood",
      executable: gateExecutable,
      args: gateArgs,
      env_allowlist: ["HOME", "LANG", "PATH", "TMPDIR"],
      timeout_ms: 30000,
    },
  ];
  config.judge_gates = [];
  if (profile === "lite") {
    delete config.model_providers;
  } else {
    config.model_providers = [
      {
        provider_ref: providerMode === "real" ? "deepseek" : "dogfood",
        model: providerMode === "real" ? "deepseek-v4-flash" : "dogfood-fixture-v1",
        slots: MODEL_SLOTS,
        is_default: true,
        timeout_ms: 300000,
      },
    ];
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  execFileSync(
    "git",
    ["add", ".harness/runtime.json", `scripts/${gateFile}`, ...(isWindows ? [".gitignore"] : [])],
    { cwd: projectRoot },
  );
  execFileSync("git", ["commit", "-m", "chore: configure dogfood runtime"], {
    cwd: projectRoot,
    stdio: "pipe",
  });
}

function approvalAllowed(profile, objectType) {
  const known = new Set([
    "CapturePrdProposal",
    "RequirementBaseline",
    "ImpactSet",
    "DesignSet",
    "ExecutionAuthorizationSpec",
  ]);
  if (!known.has(objectType)) return false;
  if (profile === "lite") return !new Set(["ImpactSet", "DesignSet"]).has(objectType);
  return true;
}

async function drive(runtime, profile, first, projectRoot) {
  const approvals = [];
  let current = first;
  for (let guard = 0; current.status === "approval_required" && guard < 12; guard += 1) {
    const objectType = current.data.object_type;
    const policyPermitted = approvalAllowed(profile, objectType);
    approvals.push({
      request_id: current.data.request_id,
      object_type: objectType,
      policy_permitted: policyPermitted,
    });
    if (!policyPermitted) throw new Error(`approval policy rejected ${String(objectType)}`);
    const approved = await runtime.approve({
      projectRoot,
      requestId: current.data.request_id,
      decision: "approve",
      actor: "human:dogfood-policy",
    });
    if (approved.status !== "ok") throw new Error(`approval failed: ${approved.message}`);
    current = await runtime.resume({
      projectRoot,
      workflowOperationId: current.data.workflow_operation_id,
    });
  }
  return { current, approvals };
}

function summarizeProject(projectRoot, profile, terminal, approvals, modelCalls) {
  const snapshots = recordsBelow(projectRoot, "artifacts/snapshots");
  const snapshot = latest(snapshots);
  const runs = recordsBelow(projectRoot, "artifacts/runs");
  const gates = recordsBelow(projectRoot, "artifacts/evidence").filter(
    (record) => record.record_kind === "evidence" && record.evidence_type === "gate_result",
  );
  const plans = recordsBelow(projectRoot, "artifacts/capability-plans");
  const plan = plans.toSorted((left, right) => left.revision - right.revision).at(-1);
  const evaluations = recordsBelow(projectRoot, "artifacts/evaluations");
  const taskVerdicts = recordsBelow(projectRoot, "artifacts/task-verdicts");
  const tddCycles = recordsBelow(projectRoot, "artifacts/tdd-cycles");
  const tddEvidence = recordsBelow(projectRoot, "artifacts/tdd-evidence");
  const tddStatuses = taskVerdicts.flatMap((record) => {
    const status = record.extensions?.["harness.tdd"]?.domain_status;
    return typeof status === "string" ? [status] : [];
  });
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  return {
    profile,
    terminal_status:
      terminal.status === "ok" && /completed/u.test(terminal.message)
        ? "completed"
        : terminal.status,
    workflow_operation_id: terminal.data?.workflow_operation_id,
    snapshot_id: snapshot?.snapshot_id,
    snapshot_status: snapshot?.status,
    snapshot_digest: snapshot?.digest,
    explicit_execution_runs: runs.length,
    gate_status: gates.some(
      (entry) => entry.extensions?.["harness.gate"]?.passed === true && entry.provisional === false,
    )
      ? "passed"
      : "missing",
    worktree_clean: status === "",
    operation_dag_nodes: plan?.operation_dag?.nodes?.map((node) => node.node_id) ?? [],
    capability_plan_id: plan?.capability_plan_id,
    capability_plan_digest: plan?.record_digest,
    approvals,
    model_invocations: modelCalls,
    evaluation_status:
      profile === "lite"
        ? "not_enabled_by_profile"
        : evaluations.some(
              (entry) =>
                entry.extensions?.["harness.evaluation"]?.passed === true &&
                entry.provisional === false,
            )
          ? "passed"
          : "missing",
    execute_subgraph: plan?.operation_dag?.nodes?.find((node) => node.node_id === "execute")
      ?.subgraph,
    tdd_status:
      profile === "lite"
        ? "not_enabled_by_profile"
        : tddStatuses.length > 0 && tddStatuses.every((status) => status === tddStatuses[0])
          ? tddStatuses[0]
          : tddStatuses.includes("tdd_incomplete_or_invalid")
            ? "tdd_incomplete_or_invalid"
            : "missing",
    tdd_cycles: tddCycles.filter((record) => record.status === "completed").length,
    tdd_evidence_types: [...new Set(tddEvidence.map((record) => record.evidence_type))].sort(),
  };
}

function createDogfoodStrictTddPort(runtimeApi, projectRoot) {
  const evidence = runtimeApi.createInMemoryTddEvidenceStore();
  return runtimeApi.createStrictTddExecutionRunner({
    workspace: runtimeApi.createInMemoryWorkspacePort({}, { baseline_commit: "dogfood-baseline" }),
    evidence,
    effectivePolicy: { fields: [], layers: [], digest: digestValue("dogfood-policy") },
    readBaseline: () =>
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
    gate: {
      run({ phase, contract }) {
        const cluster = contract.assertion_clusters[0];
        const failed = phase === "red";
        return Promise.resolve({
          result: {
            outcome: "structured",
            runs: [
              {
                selector_id: cluster.target_test_selectors[0],
                status: failed ? "failed" : "passed",
                assertion_id: cluster.assertion_ids[0],
                ...(failed
                  ? {
                      failure_kind: "assertion_failure",
                      message:
                        cluster.failure_oracle.normalized_message_patterns?.[0] ??
                        "the accepted dogfood assertion fails before implementation",
                    }
                  : {}),
              },
            ],
          },
          target_gate_binding_digest: digestValue({ gate: cluster.target_gate_id }),
          framework_profile_digest: cluster.framework_profile_digest,
          executor_environment_digest: digestValue("packaged-dogfood-environment"),
          output_artifact: {
            locator: `memory://dogfood/${phase}`,
            digest: digestValue({ phase, task: contract.task_id }),
          },
        });
      },
    },
    executor: {
      authorTests({ task }) {
        return Promise.resolve({
          files: [
            {
              path: "tests/dogfood.test.ts",
              content: `test("${task.id}", () => expect(dogfood()).toBe(true));\n`,
            },
          ],
        });
      },
      implement({ task }) {
        return Promise.resolve({
          files: [
            {
              path: "src/dogfood.ts",
              content: "export const dogfood = () => true;\n",
            },
          ],
          implementation_revision: digestValue({ task: task.id, state: "green" }),
        });
      },
    },
  });
}

async function installedHost(input) {
  const runtimeApi = await import("universal-harness");
  const { createOrchestratedRuntimeService } = runtimeApi;
  const parent = join(input.root, `profile-${input.profile}`);
  mkdirSync(parent, { recursive: true });
  const io = { writeStdout() {}, writeStderr() {}, isInteractive: false };
  let modelCalls = 0;
  const providerFetch =
    input.providerMode === "fake"
      ? async (...args) => {
          modelCalls += 1;
          return fakeFetch(...args, input.profile);
        }
      : undefined;
  const runtimeOptions = {
    cwd: parent,
    io,
    decisionActor: "human:dogfood-policy",
    ...(input.providerMode === "fake"
      ? {
          providerRegistry: fakeRegistry(),
          providerFetch,
          providerEnvironment: { HARNESS_DOGFOOD_KEY: "fixture-only-not-a-secret" },
        }
      : {}),
  };
  const bootstrapRuntime = createOrchestratedRuntimeService(runtimeOptions);
  const projectName = `dogfood-${input.profile}`;
  const created = await bootstrapRuntime.newProject({
    name: projectName,
    intent: "Prove the complete managed Harness vertical loop without changing product files.",
    profile: input.profile,
  });
  const expectedRoot = join(parent, projectName);
  if (created.status === "failed" && !existsSync(join(expectedRoot, ".harness"))) {
    throw new Error(created.message);
  }
  const projectRoot = created.data?.project_root ?? expectedRoot;
  // `new` intentionally starts a bootstrap operation before project-specific
  // runtime configuration exists. Close it against its original baseline;
  // mutating configuration underneath an approval checkpoint would be drift.
  if (created.data?.workflow_operation_id !== undefined && created.status !== "completed") {
    await bootstrapRuntime.abort({
      projectRoot,
      workflowOperationId: created.data.workflow_operation_id,
    });
  }
  writeRuntimeConfig(projectRoot, input.profile, input.providerMode, input.agentScript);
  const runtime = createOrchestratedRuntimeService({
    ...runtimeOptions,
    cwd: projectRoot,
    ...(input.profile === "governed"
      ? { strictTdd: createDogfoodStrictTddPort(runtimeApi, projectRoot) }
      : {}),
  });
  const iteration = await runtime.iterate({
    projectRoot,
    text: "Run the authoritative three-profile remediation dogfood iteration.",
  });
  const driven = await drive(runtime, input.profile, iteration, projectRoot);
  if (driven.current.status !== "ok" || !/completed/u.test(driven.current.message)) {
    throw new Error(
      `${input.profile} did not complete: ${driven.current.status} ${driven.current.message}`,
    );
  }
  return summarizeProject(projectRoot, input.profile, driven.current, driven.approvals, modelCalls);
}

function buildAndInstall(sandbox) {
  execFileSync(PNPM, ["build"], { cwd: REPOSITORY_ROOT, stdio: "pipe", shell: NEEDS_SHELL });
  execFileSync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "pack-cli.mjs")], {
    cwd: REPOSITORY_ROOT,
    stdio: "pipe",
  });
  const manifest = readJson(join(REPOSITORY_ROOT, "packages", "cli", "package.json"));
  const tarball = join(REPOSITORY_ROOT, ".pack", `${manifest.name}-${manifest.version}.tgz`);
  writeFileSync(
    join(sandbox, "package.json"),
    `${JSON.stringify({ name: "harness-three-profile-dogfood", private: true, type: "module" })}\n`,
  );
  const install = spawnSync(
    NPM,
    ["install", "--no-audit", "--no-fund", "--no-save", "--offline", tarball],
    { cwd: sandbox, encoding: "utf8", timeout: 180000, shell: NEEDS_SHELL },
  );
  if (install.status !== 0) {
    throw new Error(`offline packaged CLI install failed:\n${install.stdout}\n${install.stderr}`);
  }
}

export async function runThreeProfileLoop(options = {}) {
  const providerMode = options.providerMode ?? "fake";
  if (providerMode === "real" && !process.env.DEEPSEEK_API_KEY) {
    const error = new Error("DEEPSEEK_API_KEY not set; real Provider dogfood skipped.");
    error.exitCode = 2;
    throw error;
  }
  const sandbox = mkdtempSync(join(tmpdir(), "harness-three-profile-"));
  try {
    buildAndInstall(sandbox);
    const hostScript = join(sandbox, "dogfood-host.mjs");
    cpSync(fileURLToPath(import.meta.url), hostScript);
    const agentScript = join(sandbox, "fake-dsh.mjs");
    writeAgentScript(agentScript);
    const input = {
      root: sandbox,
      providerMode,
      agentScript,
      profiles: ["lite", "standard", "governed"],
    };
    const inputPath = join(sandbox, "input.json");
    const outputPath = join(sandbox, "output.json");
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
    const child = spawnSync(process.execPath, [hostScript, HOST_FLAG, inputPath, outputPath], {
      cwd: sandbox,
      env: process.env,
      encoding: "utf8",
      timeout: 300000,
    });
    if (child.status !== 0) {
      throw new Error(`packaged CLI host failed in ${sandbox}:\n${child.stdout}\n${child.stderr}`);
    }
    return readJson(outputPath);
  } finally {
    if (options.keepTemp !== true)
      // The just-exited host child can keep sandbox files locked briefly on
      // Windows; retry instead of racing it.
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

async function hostMain(inputPath, outputPath) {
  const input = readJson(inputPath);
  const profiles = [];
  for (const profile of input.profiles) {
    profiles.push(await installedHost({ ...input, profile }));
  }
  writeFileSync(outputPath, `${JSON.stringify({ status: "passed", profiles }, null, 2)}\n`);
}

if (process.argv[2] === HOST_FLAG) {
  await hostMain(process.argv[3], process.argv[4]);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const providerMode = process.argv.includes("--real") ? "real" : "fake";
  const outputPath = process.argv.find((entry) => entry.endsWith(".json"));
  try {
    const report = await runThreeProfileLoop({ providerMode });
    if (outputPath !== undefined) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error?.exitCode === 2 ? 2 : 1);
  }
}
