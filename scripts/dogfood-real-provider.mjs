#!/usr/bin/env node
/**
 * T20 slice 3: three-profile real-provider dogfood driver.
 *
 * Drives lite/standard/governed projects through the managed model layer
 * against the real DeepSeek endpoint (OpenAI-compatible). Every profile gets
 * two iterations: the first (created by `new`) captures with the generic
 * interpreter and runs ahead until it pauses or blocks (Standard/Governed
 * block at design — no ports exist yet); the model_providers config is then
 * written and the blocked operation aborted. The second iteration (`iterate`)
 * runs the whole model-backed pipeline against the real provider: capture
 * through the managed PrdProposalPort, impact advisory, design
 * proposal/review and context enrichment. Operations that end blocked (no
 * agent executor is configured on purpose: execution is not under test) are
 * aborted before the next iteration.
 *
 * Usage: DEEPSEEK_API_KEY=... node scripts/dogfood-real-provider.mjs [out.json]
 * Exits 2 without calling anything when the key is absent.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOrchestratedRuntimeService } from "../packages/cli/dist/index.js";
import { readModelInvocationRecords } from "../packages/runtime/dist/index.js";

if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === "") {
  console.error("DEEPSEEK_API_KEY not set; real provider dogfood skipped.");
  process.exit(2);
}

const OUT_PATH = process.argv[2] ?? join(tmpdir(), `harness-dogfood-${String(Date.now())}.json`);

const SLOTS = [
  "prd_proposal",
  "design_proposal",
  "design_review",
  "impact_advisory",
  "context_enrichment",
  "iteration_narrative",
];

const INTENT = "Let users export the monthly report as a CSV file.";
const FOLLOWUP = "Add a --delimiter option to the CSV export.";

const io = { writeStdout() {}, writeStderr() {}, isInteractive: false };
const autoApprove = { prompt: () => Promise.resolve("approve") };

function serviceFor(cwd) {
  return createOrchestratedRuntimeService({
    cwd,
    io,
    prompter: autoApprove,
    decisionActor: "human:dogfood",
  });
}

function writeModelProviders(projectRoot) {
  const configPath = join(projectRoot, ".harness", "runtime.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.model_providers = [
    {
      provider_id: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      api_key_env: "DEEPSEEK_API_KEY",
      env_allowlist: ["DEEPSEEK_API_KEY"],
      timeout_ms: 300000,
      slots: SLOTS,
    },
  ];
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function summarize(result) {
  return {
    command: result.command,
    status: result.status,
    message: result.message,
    ...(result.data?.object_type === undefined ? {} : { object_type: result.data.object_type }),
    ...(result.data?.reason === undefined ? {} : { reason: result.data.reason }),
  };
}

/**
 * Approve + resume while the operation pauses for decisions. A blocked
 * operation is never resumed by the driver: with the config written after
 * `new`, the interesting model path is the NEXT iteration's fresh capture,
 * and resuming a design-blocked legacy operation adds no model coverage.
 */
async function drive(service, projectRoot, first) {
  const log = [summarize(first)];
  let current = first;
  let guard = 0;
  while (current.status === "approval_required" && guard < 12) {
    guard += 1;
    const approved = await service.approve({
      projectRoot,
      requestId: current.data.request_id,
      decision: "approve",
    });
    log.push(summarize(approved));
    if (approved.status !== "ok") break;
    current = await service.resume({
      projectRoot,
      workflowOperationId: current.data.workflow_operation_id,
    });
    log.push(summarize(current));
  }
  return { log, terminal: current };
}

/** Abort the operation when driving stopped on a block; completed/failed need nothing. */
async function abortIfOpen(service, projectRoot, terminal) {
  if (terminal.status !== "blocked") return undefined;
  return summarize(
    await service.abort({ projectRoot, workflowOperationId: terminal.data.workflow_operation_id }),
  );
}

function invocationEvidence(projectRoot) {
  return readModelInvocationRecords(projectRoot).map((record) => ({
    invocation_id: record.invocation_id,
    conversation_id: record.conversation_id,
    run_id: record.run_id,
    attempt: record.attempt,
    port_id: record.port_id,
    ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
    state: record.state,
    provider_identity: record.provider_identity,
    prompt_contract_id: record.prompt_contract_id,
    prompt_contract_version: record.prompt_contract_version,
    prompt_contract_digest: record.prompt_contract_digest,
    output_schema_id: record.output_schema_id,
    output_schema_digest: record.output_schema_digest,
    config_digest: record.config_digest,
    budget_profile: record.budget_profile,
    compiled_prompt_digest: record.compiled_prompt_digest,
    input_bundle_digest: record.input_bundle_digest,
    ...(record.failure === undefined ? {} : { failure: record.failure }),
  }));
}

const runs = [];
const profiles = (process.env.DOGFOOD_PROFILES ?? "lite,standard,governed").split(",");
for (const profile of profiles) {
  const parent = mkdtempSync(join(tmpdir(), `harness-dogfood-${profile}-`));
  const service = serviceFor(parent);
  const run = { profile, firstIteration: [], secondIteration: [], invocations: [] };
  runs.push(run);
  try {
    const created = await service.newProject({
      name: `dogfood-${profile}`,
      intent: INTENT,
      profile,
    });
    if (created.status === "failed") {
      run.error = created.message;
      continue;
    }
    const projectRoot = created.data.project_root;
    run.projectRoot = projectRoot;
    // The first iteration starts without model coverage; writing the config
    // before the second iteration routes its capture through the managed
    // model layer.
    writeModelProviders(projectRoot);
    const first = await drive(service, projectRoot, created);
    run.firstIteration = first.log;
    const firstAbort = await abortIfOpen(service, projectRoot, first.terminal);
    if (firstAbort !== undefined) run.firstIteration.push(firstAbort);
    const iterated = await service.iterate({ projectRoot, text: FOLLOWUP });
    const second = await drive(service, projectRoot, iterated);
    run.secondIteration = second.log;
    const secondAbort = await abortIfOpen(service, projectRoot, second.terminal);
    if (secondAbort !== undefined) run.secondIteration.push(secondAbort);
    run.invocations = invocationEvidence(projectRoot);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    if (run.projectRoot !== undefined) {
      try {
        run.invocations = invocationEvidence(run.projectRoot);
      } catch {
        // evidence collection must never mask the original error
      }
    }
  }
  console.log(
    `[${profile}] ` +
      (run.error === undefined
        ? `invocations: ${String(run.invocations.length)} ` +
          `(${run.invocations.map((record) => `${record.port_id}${record.purpose === undefined ? "" : `:${record.purpose}`}/${record.state}`).join(", ")})`
        : `error: ${run.error.slice(0, 200)}`),
  );
}

writeFileSync(OUT_PATH, `${JSON.stringify(runs, null, 2)}\n`, "utf8");
console.log(`evidence written to ${OUT_PATH}`);
