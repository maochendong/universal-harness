import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ProcessSpawnError,
  runCommandProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "@universal-harness-internal/adapter-agent-command";
import { sha256Hex } from "@universal-harness-internal/core";
import {
  LLM_JUDGE_EXTENSION_KEY,
  runLlmJudge,
  type JudgeTransportDependencies,
  type ReviewBundleInput,
} from "@universal-harness-internal/adapter-gate-llm-judge";
import {
  canonicalizeJson,
  harnessRootFor,
  readCommittedOperations,
  TrustedProviderError,
  type EdgeRecord,
  type NodeRecord,
  type ResolvedTrustedProvider,
  type TrustedProviderRegistry,
} from "@universal-harness-internal/core";
import { materializeLedger, pageEdges, pageNodes } from "@universal-harness-internal/graph";
import {
  assertWithinRepositoryBoundary,
  createDefaultGateSuite,
  normalizeGateDefinition,
  hashWorktreeCode,
  resolveLlmJudgeMandatory,
  type GateDefinition,
  type ToolRegistry,
} from "@universal-harness-internal/runtime";

import { BUILTIN_TRUSTED_PROVIDER_REGISTRY } from "./model-providers.js";
import type {
  ProjectJudgeGateConfig,
  ProjectJudgeGateReference,
  ProjectRuntimeConfig,
} from "./project-runtime-config.js";

export type GateProcessRunner = (
  executable: string,
  options: ProcessRunOptions,
) => Promise<ProcessRunResult>;

export interface ConfiguredGateSuiteOptions {
  readonly spawnProcess?: GateProcessRunner;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly judgeTransport?: Omit<JudgeTransportDependencies, "ambientEnvironment">;
  readonly reviewBundle?: (projectRoot: string, gate: ProjectJudgeGateConfig) => ReviewBundleInput;
  readonly providerRegistry?: TrustedProviderRegistry;
}

interface ResolvedProjectJudgeGate extends ProjectJudgeGateConfig {
  readonly trusted_provider_policy_digest: string;
}

function trustedJudgeProvider(
  gate: ProjectJudgeGateConfig | ProjectJudgeGateReference,
  registry: TrustedProviderRegistry,
): ResolvedTrustedProvider {
  try {
    return "provider_ref" in gate
      ? registry.resolve({ provider_ref: gate.provider_ref, consumer: "llm_judge" })
      : registry.matchLegacy({
          endpoint: gate.endpoint,
          api_key_env: gate.api_key_env,
          env_allowlist: gate.env_allowlist,
          allow_loopback_http: gate.allow_loopback_http ?? false,
          consumer: "llm_judge",
        });
  } catch (error) {
    if (error instanceof TrustedProviderError) {
      throw new Error(`Judge trusted provider resolution failed: ${error.code}`, { cause: error });
    }
    throw error;
  }
}

function resolveJudgeGate(
  gate: ProjectJudgeGateConfig | ProjectJudgeGateReference,
  registry: TrustedProviderRegistry,
): ResolvedProjectJudgeGate {
  const trusted = trustedJudgeProvider(gate, registry);
  return {
    gate_id: gate.gate_id,
    name: gate.name,
    subject_id: gate.subject_id,
    requested_mandatory: gate.requested_mandatory,
    endpoint: trusted.endpoint,
    model: gate.model,
    prompt_version: gate.prompt_version,
    api_key_env: trusted.api_key_env,
    env_allowlist: trusted.env_allowlist,
    timeout_ms: gate.timeout_ms,
    ...(gate.seed === undefined ? {} : { seed: gate.seed }),
    allow_loopback_http: trusted.allow_loopback_http,
    trusted_provider_policy_digest: trusted.policy_digest,
  };
}

function environmentFor(
  allowlist: readonly string[],
  ambient: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of allowlist) {
    const value = ambient[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function gateToolName(gateId: string): string {
  return `project_${gateId}`;
}

function judgeToolName(gateId: string): string {
  return `project_${gateId}_llm_judge`;
}

interface CurrentGraph {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
}

function currentGraph(projectRoot: string): CurrentGraph {
  const { database } = materializeLedger({ projectRoot, databasePath: ":memory:" });
  try {
    const allNodes: NodeRecord[] = [];
    let cursor: string | undefined;
    do {
      const result = pageNodes(database, {
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      allNodes.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    const currentById = new Map<string, NodeRecord>();
    for (const node of allNodes) {
      const current = currentById.get(node.id);
      if (current === undefined || node.revision > current.revision) currentById.set(node.id, node);
    }
    const edges: EdgeRecord[] = [];
    let edgeCursor: string | undefined;
    do {
      const result = pageEdges(database, {
        limit: 500,
        ...(edgeCursor === undefined ? {} : { cursor: edgeCursor }),
      });
      edges.push(...result.items);
      edgeCursor = result.nextCursor;
    } while (edgeCursor !== undefined);
    return {
      nodes: [...currentById.values()].filter((node) => node.status !== "tombstoned"),
      edges,
    };
  } finally {
    database.close();
  }
}

function gitOutput(projectRoot: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function acceptanceCriteria(nodes: readonly NodeRecord[]): string[] {
  const criteria: string[] = [];
  for (const node of nodes) {
    if (node.type !== "Task") continue;
    const extension = node.extensions?.["harness.task"];
    if (typeof extension !== "object" || extension === null) continue;
    const acceptance = (extension as { acceptance?: unknown }).acceptance;
    if (!Array.isArray(acceptance)) continue;
    for (const entry of acceptance) {
      if (typeof entry === "string") criteria.push(entry);
      else if (typeof entry === "object" && entry !== null) {
        const description = (entry as { description?: unknown }).description;
        if (typeof description === "string") criteria.push(description);
      }
    }
  }
  return [...new Set(criteria)].sort();
}

function deterministicGateSummaries(
  nodes: readonly NodeRecord[],
): ReviewBundleInput["deterministic_gates"] {
  return nodes
    .filter((node) => node.type === "Evidence")
    .flatMap((node) => {
      const gate = node.extensions?.["harness.gate"];
      if (typeof gate !== "object" || gate === null) return [];
      const value = gate as { gate_id?: unknown; passed?: unknown; summary?: unknown };
      if (
        typeof value.gate_id !== "string" ||
        typeof value.passed !== "boolean" ||
        typeof value.summary !== "string" ||
        node.extensions?.[LLM_JUDGE_EXTENSION_KEY] !== undefined
      ) {
        return [];
      }
      return [{ gate_id: value.gate_id, passed: value.passed, summary: value.summary }];
    })
    .sort((left, right) =>
      left.gate_id < right.gate_id ? -1 : left.gate_id > right.gate_id ? 1 : 0,
    );
}

function defaultReviewBundle(
  projectRoot: string,
  gate: ProjectJudgeGateConfig,
  graph: CurrentGraph,
): ReviewBundleInput {
  const operations = readCommittedOperations(harnessRootFor(projectRoot));
  const sourceCommit = gitOutput(projectRoot, ["rev-parse", "HEAD"]).trim() || "unborn";
  const baselineCommit = operations.at(-1)?.manifest.baseline_commit ?? sourceCommit;
  const pathspec = ["--", ".", ":(exclude).harness", ":(exclude).git"];
  const diff = gitOutput(projectRoot, ["diff", "--no-ext-diff", baselineCommit, ...pathspec]);
  const changedPaths = gitOutput(projectRoot, ["diff", "--name-only", baselineCommit, ...pathspec])
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const lineCounts: Record<string, number> = {};
  for (const path of changedPaths) {
    const absolute = join(projectRoot, path);
    if (!existsSync(absolute)) continue;
    const content = readFileSync(absolute, "utf8");
    lineCounts[path] = content === "" ? 0 : content.split(/\r?\n/u).length;
  }
  const relatedIds = new Set([gate.subject_id]);
  for (const edge of graph.edges) {
    if (edge.status === "rejected" || edge.status === "superseded") continue;
    if (edge.source_id === gate.subject_id) relatedIds.add(edge.target_id);
    if (edge.target_id === gate.subject_id) relatedIds.add(edge.source_id);
  }
  const allowedTypes = new Set<NodeRecord["type"]>([
    "Requirement",
    "Constraint",
    "Decision",
    "Policy",
    "Component",
    "Task",
    "Test",
  ]);
  const relatedRecords = graph.nodes
    .filter((node) => relatedIds.has(node.id) && allowedTypes.has(node.type))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((node) => ({
      id: node.id,
      type: node.type,
      revision: node.revision,
      digest: node.digest,
      ...(node.extensions === undefined
        ? {}
        : { summary: canonicalizeJson(node.extensions).slice(0, 4000) }),
    }));
  return {
    baseline_commit: baselineCommit,
    source_commit: sourceCommit,
    code_digest: hashWorktreeCode(projectRoot),
    changed_paths: changedPaths,
    diff,
    acceptance_criteria: acceptanceCriteria(graph.nodes),
    related_records: relatedRecords,
    deterministic_gates: deterministicGateSummaries(graph.nodes),
    line_counts: lineCounts,
  };
}

/** Assemble universal integrity and committed project command gates into one suite. */
export function createConfiguredGateSuite(
  projectRoot: string,
  config: ProjectRuntimeConfig,
  options: ConfiguredGateSuiteOptions = {},
): { readonly gates: readonly GateDefinition[]; readonly registry: ToolRegistry } {
  const suite = createDefaultGateSuite(projectRoot);
  const gates: GateDefinition[] = [...suite.gates];
  const spawnProcess = options.spawnProcess ?? runCommandProcess;
  const ambient = options.ambientEnvironment ?? process.env;

  for (const command of config.gates) {
    const executable = assertWithinRepositoryBoundary(projectRoot, command.executable);
    const tool = gateToolName(command.gate_id);
    suite.registry.register(
      {
        name: tool,
        version: "1.0.0",
        description: `run committed project gate ${command.gate_id}`,
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        output_schema: {
          type: "object",
          properties: {
            exit_code: { type: "integer" },
            passed: { type: "boolean" },
            summary: { type: "string" },
            log_summary: { type: "string" },
            artifacts: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["exit_code", "passed", "summary", "log_summary", "artifacts"],
          additionalProperties: false,
        },
        allowed_phases: ["verification"],
        resource_patterns: [],
        risk: "low",
        side_effect_class: "none",
        requires_approval: false,
        timeout_ms: command.timeout_ms,
        retry_class: "none",
        max_retries: 0,
        max_invocations_per_run: 10,
        idempotent: true,
        reconciliation: "provider",
      },
      async () => {
        let result: ProcessRunResult;
        try {
          result = await spawnProcess(executable, {
            args: command.args,
            cwd: projectRoot,
            env: environmentFor(command.env_allowlist, ambient),
            timeout_ms: command.timeout_ms,
            max_output_bytes: 4 * 1024 * 1024,
          });
        } catch (error) {
          if (!(error instanceof ProcessSpawnError)) throw error;
          result = {
            exit_code: 127,
            signal: null,
            stdout: "",
            stderr: error.message,
            timed_out: false,
            output_truncated: false,
            aborted: false,
            duration_ms: 0,
          };
        }
        const effectiveExitCode = result.timed_out
          ? 124
          : result.output_truncated
            ? 125
            : (result.exit_code ?? 126);
        const passed = effectiveExitCode === 0;
        const log = [
          `gate=${command.gate_id}`,
          `exit_code=${String(effectiveExitCode)}`,
          `duration_ms=${String(result.duration_ms)}`,
          "stdout:",
          result.stdout,
          "stderr:",
          result.stderr,
        ].join("\n");
        const relativeLog = `.harness/raw-traces/gates/${command.gate_id}.log`;
        const absoluteLog = join(projectRoot, relativeLog);
        mkdirSync(dirname(absoluteLog), { recursive: true });
        writeFileSync(absoluteLog, log, "utf8");
        const combined = `${result.stdout}\n${result.stderr}`.trim();
        return {
          exit_code: effectiveExitCode,
          passed,
          summary: `${command.name} ${passed ? "passed" : "failed"}`,
          log_summary: combined.slice(-2000),
          artifacts: { [relativeLog]: sha256Hex(log) },
        };
      },
    );
    gates.push(
      normalizeGateDefinition({
        gate_id: command.gate_id,
        layer: "project",
        name: command.name,
        mandatory: command.mandatory,
        subject_id: command.subject_id,
        tool,
      }),
    );
  }
  const providerRegistry = options.providerRegistry ?? BUILTIN_TRUSTED_PROVIDER_REGISTRY;
  const judgeGates = (config.judge_gates ?? []).map((gate) =>
    resolveJudgeGate(gate, providerRegistry),
  );
  const graph = judgeGates.length === 0 ? undefined : currentGraph(projectRoot);
  for (const judge of judgeGates) {
    const resolution = resolveLlmJudgeMandatory(
      judge.gate_id,
      judge.requested_mandatory,
      graph?.nodes ?? [],
      graph?.edges ?? [],
    );
    const tool = judgeToolName(judge.gate_id);
    suite.registry.register(
      {
        name: tool,
        version: "1.0.0",
        description: `run optional LLM judge gate ${judge.gate_id}`,
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        output_schema: {
          type: "object",
          properties: {
            exit_code: { type: "integer" },
            passed: { type: "boolean" },
            summary: { type: "string" },
            log_summary: { type: "string" },
            artifacts: { type: "object", additionalProperties: { type: "string" } },
            extensions: {
              type: "object",
              properties: {
                [LLM_JUDGE_EXTENSION_KEY]: { type: "object", additionalProperties: true },
              },
              required: [LLM_JUDGE_EXTENSION_KEY],
              additionalProperties: false,
            },
          },
          required: ["exit_code", "passed", "summary", "log_summary", "artifacts", "extensions"],
          additionalProperties: false,
        },
        allowed_phases: ["verification"],
        resource_patterns: [],
        risk: "medium",
        side_effect_class: "none",
        requires_approval: false,
        timeout_ms: judge.timeout_ms + 1000,
        retry_class: "none",
        max_retries: 0,
        max_invocations_per_run: 3,
        idempotent: true,
        reconciliation: "provider",
      },
      async () => {
        const bundle =
          options.reviewBundle?.(projectRoot, judge) ??
          defaultReviewBundle(projectRoot, judge, graph as CurrentGraph);
        const result = await runLlmJudge(
          {
            endpoint: judge.endpoint,
            model: judge.model,
            api_key_env: judge.api_key_env,
            env_allowlist: judge.env_allowlist,
            timeout_ms: judge.timeout_ms,
            prompt_version: judge.prompt_version,
            ...(judge.seed === undefined ? {} : { seed: judge.seed }),
            ...(judge.allow_loopback_http === undefined
              ? {}
              : { allow_loopback_http: judge.allow_loopback_http }),
            trusted_provider_policy_digest: judge.trusted_provider_policy_digest,
          },
          bundle,
          {
            ...(options.judgeTransport ?? {}),
            ambientEnvironment: ambient,
          },
        );
        const metadata = result.extensions[LLM_JUDGE_EXTENSION_KEY];
        return {
          ...result,
          extensions: {
            [LLM_JUDGE_EXTENSION_KEY]: {
              ...metadata,
              requested_mandatory: judge.requested_mandatory,
              effective_mandatory: resolution.mandatory,
              policy_diagnostics: resolution.diagnostics,
              ...(resolution.policy_digest === undefined
                ? {}
                : { policy_digest: resolution.policy_digest }),
              ...(resolution.approval_id === undefined
                ? {}
                : { approval_id: resolution.approval_id }),
            },
          },
        };
      },
    );
    gates.push(
      normalizeGateDefinition({
        gate_id: judge.gate_id,
        layer: "project",
        name: judge.name,
        mandatory: resolution.mandatory,
        subject_id: judge.subject_id,
        tool,
      }),
    );
  }
  return { gates, registry: suite.registry };
}
