import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  canonicalizeJson,
  contentDigest,
  validateSchema,
  type ImpactAdvisoryOutput,
  type JevImpactJudgments,
} from "@universal-harness-internal/core";
import { RISK_LEVELS, maxRisk, type ImpactAdvisoryInput } from "@universal-harness-internal/graph";

import type { JevInputPreparation } from "./jev-impact-input.js";

export class JevImpactMappingError extends Error {
  readonly kind = "invalid_output";

  constructor(summary: string) {
    super(summary);
    this.name = "JevImpactMappingError";
  }
}

function validateSources(
  input: ImpactAdvisoryInput,
  prepared: Extract<JevInputPreparation, { status: "ready" }>,
  judgments: JevImpactJudgments,
): void {
  const { request, binding } = prepared;
  if (
    request.model !== "jev-1.13.0" ||
    binding.impact_set_digest !== input.impact_set_digest ||
    binding.rule_registry_version !== input.rule_registry_version ||
    binding.rule_registry_digest !== input.rule_registry_digest ||
    binding.projection_version !== "jev-impact-projection.v1" ||
    binding.mapping_version !== "jev-impact-mapping.v1" ||
    binding.limits_version !== "jev-impact-limits.v1" ||
    binding.candidate_set_digest !== contentDigest(request.state.candidates) ||
    judgments.harness.request_digest !== contentDigest(request) ||
    judgments.harness.candidate_set_digest !== binding.candidate_set_digest ||
    judgments.harness.mapping_version !== binding.mapping_version
  ) {
    throw new JevImpactMappingError("Jev judgments no longer match the current request binding");
  }
  const candidateIds = request.state.candidates.map((node) => node.id).sort();
  if (
    candidateIds.length === 0 ||
    new Set(candidateIds).size !== candidateIds.length ||
    canonicalizeJson(candidateIds) !== canonicalizeJson(Object.keys(request.questions).sort())
  ) {
    throw new JevImpactMappingError("Jev candidate and question identities are inconsistent");
  }
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  if (nodes.size !== input.nodes.length) {
    throw new JevImpactMappingError("Jev source graph has duplicate node identities");
  }
  const primary = input.deterministic_entries.filter((entry) => entry.path.length === 0);
  if (
    primary.length !== 1 ||
    !["Intent", "Requirement"].includes(primary[0]!.node_type) ||
    primary[0]!.node_id !== request.state.change.id ||
    primary[0]!.node_type !== request.state.change.type ||
    input.deterministic_entries.some(
      (entry) =>
        !RISK_LEVELS.includes(entry.risk) || nodes.get(entry.node_id)?.type !== entry.node_type,
    )
  ) {
    throw new JevImpactMappingError("Jev change seed or deterministic risk baseline is invalid");
  }
  const deterministicIds = new Set(input.deterministic_entries.map((entry) => entry.node_id));
  if (candidateIds.some((id) => deterministicIds.has(id))) {
    throw new JevImpactMappingError("Jev cannot add an existing deterministic entry");
  }
  for (const projected of [request.state.change, ...request.state.candidates]) {
    const node = nodes.get(projected.id);
    if (
      node === undefined ||
      node.status !== "accepted" ||
      !validateSchema("node", node).valid ||
      node.type !== projected.type ||
      node.revision !== projected.revision ||
      node.digest !== projected.digest
    ) {
      throw new JevImpactMappingError("Jev source reference does not match the current graph node");
    }
    const { digest, ...content } = node;
    if (digest !== contentDigest(content)) {
      throw new JevImpactMappingError("Jev source node content no longer matches its digest");
    }
  }
}

export function mapJevImpactJudgments(
  input: ImpactAdvisoryInput,
  prepared: Extract<JevInputPreparation, { status: "ready" }>,
  judgments: JevImpactJudgments,
): ImpactAdvisoryOutput {
  if (!PROTOCOL_1_1_SCHEMA_REGISTRY.validate("jev-impact-judgments", judgments).valid) {
    throw new JevImpactMappingError("Jev cached judgments violate the strict output schema");
  }
  validateSources(input, prepared, judgments);
  const response = judgments.provider_response;
  if (
    canonicalizeJson(Object.keys(response.answers).sort()) !==
    canonicalizeJson(Object.keys(prepared.request.questions).sort())
  ) {
    throw new JevImpactMappingError("Jev answer set differs from the requested candidates");
  }
  for (const answer of Object.values(response.answers)) {
    const probabilities = Object.values(answer.probabilities);
    if (
      !probabilities.every(Number.isFinite) ||
      !Number.isFinite(answer.confidence) ||
      Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 0.002 + Number.EPSILON ||
      answer.probabilities[answer.choice] < Math.max(...probabilities)
    ) {
      throw new JevImpactMappingError("Jev cached answer probability distribution is invalid");
    }
  }
  if (!Number.isSafeInteger(response.usage.input_tokens + response.usage.output_tokens)) {
    throw new JevImpactMappingError("Jev cached token usage is not a safe integer");
  }
  const risk = input.deterministic_entries.map((entry) => entry.risk).reduce(maxRisk);
  const seed = prepared.request.state.change;
  const output: ImpactAdvisoryOutput = {
    purpose: "impact_advisory",
    schema_version: "impact-advisory.v1",
    impact_set_digest: input.impact_set_digest,
    additions: [],
    edge_candidates: [],
    risk_signals: [],
    missing_facts: [],
    questions: [],
  };
  for (const candidate of prepared.request.state.candidates) {
    const answer = judgments.provider_response.answers[candidate.id]!;
    const source_refs = [
      { kind: "graph_node" as const, ref: seed.id, digest: seed.digest },
      { kind: "graph_node" as const, ref: candidate.id, digest: candidate.digest },
    ];
    if (
      answer.choice === "insufficient" ||
      answer.probabilities[answer.choice] < 0.8 ||
      answer.confidence < 0.8
    ) {
      output.missing_facts.push({
        subject_id: candidate.id,
        fact: "所提供事实不足以明确判断候选与变更的关系。",
        why_it_matters: "判断不明确不能作为无影响结论，需补充契约后重新评估。",
        source_refs,
      });
      output.questions.push({
        target_id: candidate.id,
        question: `请补充 ${candidate.id} 与本次变更相关的行为、接口或数据契约。`,
      });
    } else if (answer.choice === "affected") {
      output.additions.push({
        node_id: candidate.id,
        node_type: candidate.type,
        classification: "inspect",
        risk,
        confidence: Math.min(0.9, Math.floor(10 * answer.probabilities.affected) / 10),
        reason: "Jev 候选检查建议；建议强度非正确率。请结合所引变更与候选契约人工复核。",
        source_refs,
      });
    }
  }
  if (output.questions.length > 0) output.additions = [];
  return output;
}
