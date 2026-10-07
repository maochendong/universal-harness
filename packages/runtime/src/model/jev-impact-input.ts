import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  PromptContractError,
  canonicalizeJson,
  contentDigest,
  validateSchema,
  type ImpactClarificationQuestion,
  type ModelPortFailure,
  type NodeRecord,
  type ProfileId,
  type PromptContractRegistry,
} from "@universal-harness-internal/core";
import {
  JEV_IMPACT_CRITERIA,
  JEV_IMPACT_PROMPT_VERSION,
  JEV_IMPACT_QUESTION_TEMPLATE,
  type ImpactAdvisoryInput,
  type ImpactAdvisoryResult,
} from "@universal-harness-internal/graph";

import type {
  JevImpactRequest,
  JevProjectedNode,
  JevRequestBinding,
} from "./jev-impact-provider.js";
import { compilePolicyOverlay } from "./prompt-policy.js";
import { PromptPreparationFailureError } from "./capture-adapters.js";
import { SourceBoundaryError, wrapUntrustedBundle } from "./source-boundary.js";

type LocalDiagnostic = NonNullable<
  Extract<ImpactAdvisoryResult, { status: "proposed" }>["local_diagnostic"]
>;

export type JevInputPreparation =
  | {
      status: "ready";
      request: JevImpactRequest;
      binding: JevRequestBinding;
      local_diagnostic: LocalDiagnostic;
    }
  | { status: "no_candidates"; excluded_count: number; local_diagnostic: LocalDiagnostic }
  | { status: "clarification_required"; questions: readonly ImpactClarificationQuestion[] }
  | { status: "failed"; failure: ModelPortFailure };

const CANDIDATE_TYPES = new Set<NodeRecord["type"]>([
  "Requirement",
  "Constraint",
  "Decision",
  "Component",
  "CodeArtifact",
  "Test",
  "DesignArtifact",
]);

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function projectNode(node: NodeRecord): JevProjectedNode | undefined {
  if (
    node.type === "Component" ||
    node.type === "CodeArtifact" ||
    (node.type === "Test" &&
      (node.source === "scanner" || node.extensions?.["harness.scan"] !== undefined))
  )
    return undefined;
  const fields: Record<string, string | readonly string[]> = {};
  const read = (namespace: string, names: readonly string[]) => {
    const source = object(node.extensions?.[namespace]);
    for (const name of names) {
      const value = source[name];
      if (typeof value === "string" && value.trim().length > 0)
        fields[`${namespace}.${name}`] = value;
    }
  };
  if (node.type === "Intent") read("harness.requirements", ["text"]);
  if (node.type === "Requirement") {
    read("harness.requirements", ["statement"]);
    const acceptance = object(node.extensions?.["harness.requirements"])["acceptance"];
    if (Array.isArray(acceptance))
      acceptance.forEach((criterion, index) => {
        for (const name of ["description", "verification"]) {
          const value = object(criterion)[name];
          if (typeof value === "string" && value.trim().length > 0)
            fields[`harness.requirements.acceptance[${index}].${name}`] = value;
        }
      });
  }
  if (node.type === "Constraint")
    read("harness.requirements", ["statement", "category", "verification_intent", "verification"]);
  if (node.type === "Test")
    read("harness.requirements", [
      "observable_outcome",
      "verification_intent",
      "verifies",
      "description",
      "verification",
    ]);
  if (node.type === "Decision") read("harness.decision", ["summary"]);
  if (node.type === "DesignArtifact") {
    const artifact = object(node.extensions?.["harness.design.artifact"]);
    const copy = (source: Record<string, unknown>, names: readonly string[], prefix: string) => {
      for (const name of names) {
        const value = source[name];
        if (typeof value === "string" && value.trim().length > 0)
          fields[`${prefix}.${name}`] = value;
        else if (Array.isArray(value) && value.every((part) => typeof part === "string"))
          fields[`${prefix}.${name}`] = [...value];
      }
    };
    copy(
      artifact,
      ["artifact_kind", "title", "summary", "assumptions", "acceptance_implications"],
      "harness.design.artifact",
    );
    const bodyFields: Record<string, readonly string[]> = {
      api_contract: ["protocol", "operations", "inputs", "outputs", "errors", "compatibility"],
      data_contract: ["entities", "constraints", "invariants", "migrations", "compatibility"],
      test_strategy: ["scenarios", "test_levels", "required_gates", "required_evidence"],
      ui_design: ["user_flows", "key_states", "error_states", "accessibility"],
    };
    copy(
      object(artifact["body"]),
      bodyFields[String(artifact["artifact_kind"])] ?? [],
      "harness.design.artifact.body",
    );
  }
  return { id: node.id, type: node.type, revision: node.revision, digest: node.digest, fields };
}

export function prepareJevImpactInput(
  input: ImpactAdvisoryInput,
  registry: PromptContractRegistry,
  profile: ProfileId,
): JevInputPreparation {
  const reject = (summary: string): JevInputPreparation => ({
    status: "failed",
    failure: { code: "policy_denied", summary, retryable: false },
  });
  const ids = new Set<string>();
  for (const node of input.nodes) {
    const { digest, ...content } = node;
    if (
      ids.has(node.id) ||
      !validateSchema("node", node).valid ||
      contentDigest(content) !== digest
    ) {
      return reject("Jev input has duplicate, malformed or stale graph nodes");
    }
    ids.add(node.id);
  }
  const primary = input.deterministic_entries.filter((entry) => entry.path.length === 0);
  if (primary.length !== 1 || !["Intent", "Requirement"].includes(primary[0]!.node_type))
    return reject("Jev requires exactly one Intent or Requirement primary seed");
  for (const entry of input.deterministic_entries) {
    const node = input.nodes.find((candidate) => candidate.id === entry.node_id);
    if (node === undefined || node.type !== entry.node_type)
      return reject("Jev deterministic entry does not resolve to its graph node");
  }
  const seedId = primary[0]!.node_id;
  const seed = input.nodes.find((node) => node.id === seedId);
  if (seed === undefined || seed.status !== "accepted") {
    return {
      status: "failed",
      failure: { code: "policy_denied", summary: "Jev requires a primary seed", retryable: false },
    };
  }
  const deterministic = new Set(input.deterministic_entries.map((entry) => entry.node_id));
  const excludedByReason = { already_deterministic: 0, not_accepted: 0, unsupported_type: 0 };
  const candidateNodes = input.nodes
    .filter((node) => {
      if (deterministic.has(node.id)) excludedByReason.already_deterministic += 1;
      else if (node.status !== "accepted") excludedByReason.not_accepted += 1;
      else if (!CANDIDATE_TYPES.has(node.type)) excludedByReason.unsupported_type += 1;
      else return true;
      return false;
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const projected: JevProjectedNode[] = [];
  const questions: ImpactClarificationQuestion[] = [];
  for (const node of [seed, ...candidateNodes]) {
    const artifact = node.extensions?.["harness.design.artifact"];
    if (
      node.type === "DesignArtifact" &&
      artifact !== undefined &&
      !PROTOCOL_1_1_SCHEMA_REGISTRY.validate("design-artifact-content", artifact).valid
    )
      return reject(
        `invalid_design_artifact: ${node.id} does not satisfy its approved content schema`,
      );
    const projection = projectNode(node);
    if (projection === undefined)
      return reject(
        `unsupported_projection: ${node.id} (${node.type}); 当前版本不支持该业务投影，请切回原生成式 Adapter 或等待后续投影版本，补证或重复恢复不能解决此限制。`,
      );
    const hasBusinessContent = Object.entries(projection.fields).some(
      ([path, value]) =>
        path !== "harness.requirements.verifies" &&
        path !== "harness.requirements.category" &&
        path !== "harness.design.artifact.artifact_kind" &&
        (typeof value === "string"
          ? value.trim().length > 0
          : value.some((part) => part.trim().length > 0)),
    );
    if (!hasBusinessContent)
      questions.push({
        target_id: node.id,
        question: `missing_business_content: 请通过需求/图谱流程补齐 ${node.id} 的业务内容，再以新基线恢复。`,
      });
    projected.push(projection);
  }
  if (questions.length > 0) return { status: "clarification_required", questions };
  const [change, ...candidates] = projected;
  const state = { change: change!, candidates };
  if (candidates.length > 20 || Buffer.byteLength(canonicalizeJson(state), "utf8") > 16_384) {
    throw new PromptPreparationFailureError({
      code: "prompt_size_exceeded",
      summary:
        "Jev 输入超过 20 个候选或 16 KiB state 上限；不会截断或分批，请缩小受控范围或切回原 Adapter。",
      retryable: false,
    });
  }
  try {
    // Check raw leaves too: JSON escaping must not hide user paths or unsafe Unicode.
    const rawFields = projected.flatMap((node) =>
      Object.values(node.fields).flatMap((value) => (typeof value === "string" ? [value] : value)),
    );
    wrapUntrustedBundle(
      {
        bundle_id: "jev-state",
        items: [
          { source_id: "jev-state", source_kind: "jev-state", text: canonicalizeJson(state) },
          ...rawFields.map((text, index) => ({
            source_id: `jev-field-${index}`,
            source_kind: "jev-field",
            text,
          })),
        ],
      },
      "source-delimiter.v1",
    );
  } catch (error) {
    if (error instanceof SourceBoundaryError)
      throw new PromptPreparationFailureError({
        code: error.code,
        summary: error.message,
        retryable: false,
      });
    throw error;
  }
  const localDiagnostic: LocalDiagnostic = {
    code: candidates.length === 0 ? "no_candidates" : "candidate_scope",
    candidate_count: candidates.length,
    excluded_count: input.nodes.length - candidates.length,
    excluded_by_reason: excludedByReason,
  };
  if (candidates.length === 0)
    return {
      status: "no_candidates",
      excluded_count: input.nodes.length,
      local_diagnostic: localDiagnostic,
    };
  let resolution: ReturnType<PromptContractRegistry["resolve"]>;
  try {
    resolution = registry.resolve({
      port_id: "impact_advisory",
      prompt_version: JEV_IMPACT_PROMPT_VERSION,
    });
  } catch (error) {
    if (error instanceof PromptContractError)
      throw new PromptPreparationFailureError({
        code: error.code,
        summary: error.message,
        retryable: false,
      });
    throw error;
  }
  const contract = registry.contracts.find(
    (entry) =>
      entry.contract_id === resolution.prompt_contract_id &&
      entry.version === resolution.prompt_contract_version,
  );
  if (contract === undefined) throw new Error("resolved Jev contract is missing");
  const instructions = [
    contract.authority_boundary.text,
    contract.role_instruction.text,
    contract.domain_rubric.text,
    contract.profile_overlays[profile].text,
    compilePolicyOverlay([]).content,
  ].join("\n");
  return {
    status: "ready",
    local_diagnostic: localDiagnostic,
    request: {
      model: "jev-1.13.0",
      state,
      questions: Object.fromEntries(
        candidates.map((candidate, index) => [
          candidate.id,
          {
            type: "choice" as const,
            instructions: `${instructions}\n${JEV_IMPACT_QUESTION_TEMPLATE}`.replaceAll(
              "{index}",
              String(index),
            ),
            criteria: JEV_IMPACT_CRITERIA,
          },
        ]),
      ),
    },
    binding: {
      impact_set_digest: input.impact_set_digest,
      rule_registry_version: input.rule_registry_version,
      rule_registry_digest: input.rule_registry_digest,
      candidate_set_digest: contentDigest(candidates),
      projection_version: "jev-impact-projection.v1",
      mapping_version: "jev-impact-mapping.v1",
      limits_version: "jev-impact-limits.v1",
    },
  };
}
