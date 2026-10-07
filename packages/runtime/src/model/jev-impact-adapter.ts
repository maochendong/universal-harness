import {
  PROTOCOL_1_1_SCHEMA_REGISTRY,
  contentDigest,
  type JevImpactJudgments,
  type ModelInvocationRecord,
  type ModelPortFailure,
  type ProfileId,
  type PromptContractRegistry,
} from "@universal-harness-internal/core";
import {
  JEV_IMPACT_PROMPT_VERSION,
  validateImpactAdvisoryMerge,
  type ImpactAdvisoryPort,
  type ImpactAdvisoryResult,
} from "@universal-harness-internal/graph";

import {
  PromptPreparationFailureError,
  consumeManagedInvocation,
  invokeManagedPrompt,
  type ManagedInvocationAdapterDeps,
} from "./capture-adapters.js";
import { prepareJevImpactInput } from "./jev-impact-input.js";
import { JevImpactMappingError, mapJevImpactJudgments } from "./jev-impact-mapping.js";
import { buildJevInputBundle, type JevImpactProviderFactory } from "./jev-impact-provider.js";
import { compilePrompt } from "./prompt-compiler.js";
import {
  ModelInvocationStoreError,
  latestModelInvocation,
  readModelInvocationRecords,
} from "./invocation-store.js";
import { ManagedRunnerError, managedInvocationCacheKey } from "./managed-runner.js";
import { ModelResultArtifactError, readValidatedModelResult } from "./result-artifact.js";

function failed(code: ModelPortFailure["code"], summary: string): ImpactAdvisoryResult {
  return { status: "failed", failure: { code, summary, retryable: false } };
}

export interface JevImpactAdapterDeps extends Omit<ManagedInvocationAdapterDeps, "provider"> {
  readonly registry: PromptContractRegistry;
  readonly profile_id: ProfileId;
  readonly provider_factory: JevImpactProviderFactory;
}

const BINDING_FIELDS = [
  "provider_identity",
  "config_digest",
  "budget_profile",
  "prompt_contract_id",
  "prompt_contract_version",
  "prompt_contract_digest",
  "output_schema_id",
  "output_schema_digest",
  "profile_overlay_digest",
  "policy_overlay_digest",
  "input_bundle_digest",
  "compiled_prompt_digest",
  "cache_key",
] as const;

function bindingMatches(
  record: ModelInvocationRecord,
  expected: Pick<ModelInvocationRecord, (typeof BINDING_FIELDS)[number]>,
): boolean {
  return (
    record.port_id === "impact_advisory" &&
    record.purpose === undefined &&
    BINDING_FIELDS.every((key) => record[key] === expected[key])
  );
}

export function createJevImpactAdvisoryPort(deps: JevImpactAdapterDeps): ImpactAdvisoryPort {
  return {
    name: "jev-impact-advisory",
    async advise(input): Promise<ImpactAdvisoryResult> {
      const prepared = prepareJevImpactInput(input, deps.registry, deps.profile_id);
      if (prepared.status === "failed" || prepared.status === "clarification_required")
        return prepared;
      if (prepared.status === "no_candidates")
        return {
          status: "proposed",
          additions: [],
          edge_candidates: [],
          risk_signals: [],
          missing_facts: [],
          questions: [],
          local_diagnostic: prepared.local_diagnostic,
        };
      const compiled = compilePrompt({
        registry: deps.registry,
        selector: { port_id: "impact_advisory", prompt_version: JEV_IMPACT_PROMPT_VERSION },
        profile: deps.profile_id,
        input_bundle: buildJevInputBundle(prepared.request, prepared.binding),
      });
      if (!compiled.ok) throw new PromptPreparationFailureError(compiled.failure);
      const contract = deps.registry.resolve({
        port_id: "impact_advisory",
        prompt_version: JEV_IMPACT_PROMPT_VERSION,
      });
      const attemptTag = contentDigest({
        workflow_operation_id: input.workflow_operation_id,
        iteration_id: input.iteration_id,
        run_id: input.run_id,
      }).slice(0, 32);
      const bindingTag = contentDigest({
        provider_config: deps.provider_config,
        compiled: compiled.compiled.compiled_prompt_digest,
      }).slice(0, 32);
      const tag = `${attemptTag}_${bindingTag}`;
      const identity = {
        invocation_id: `jev-invocation_${tag}`,
        run_id: `jev-run_${tag}`,
        conversation_id: `jev-conversation_${tag}`,
      };
      const binding = {
        ...deps.provider_config,
        prompt_contract_id: contract.prompt_contract_id,
        prompt_contract_version: contract.prompt_contract_version,
        prompt_contract_digest: contract.prompt_contract_digest,
        output_schema_digest: contract.output_schema_digest,
      };
      const expected = {
        ...binding,
        output_schema_id: contract.output_schema_id,
        profile_overlay_digest: compiled.compiled.profile_overlay_digest,
        policy_overlay_digest: compiled.compiled.policy_overlay_digest,
        input_bundle_digest: compiled.compiled.input_bundle_digest,
        compiled_prompt_digest: compiled.compiled.compiled_prompt_digest,
        cache_key: managedInvocationCacheKey({
          port_id: "impact_advisory",
          binding,
          compiled: compiled.compiled,
        }),
      };
      const validateOutput = (value: unknown) => {
        const output = mapJevImpactJudgments(input, prepared, value as JevImpactJudgments);
        if (!PROTOCOL_1_1_SCHEMA_REGISTRY.validate("impact-advisory-output", output).valid)
          throw new JevImpactMappingError(
            "Jev mapped suggestions violate the domain output schema",
          );
        const issues = validateImpactAdvisoryMerge({
          output,
          deterministic_entries: input.deterministic_entries,
          impact_set_digest: input.impact_set_digest,
          nodes: input.nodes,
          requirement_digests: input.requirement_digests,
          rule_registry_version: input.rule_registry_version,
          rule_registry_digest: input.rule_registry_digest,
        });
        if (issues.length > 0)
          throw new JevImpactMappingError("Jev suggestion failed current impact merge validation");
        return output;
      };
      try {
        const records = readModelInvocationRecords(deps.projectRoot);
        // A changed binding is not authority to retry an existing workflow attempt.
        if (
          records.some(
            (record) =>
              record.invocation_id.startsWith(`jev-invocation_${attemptTag}_`) &&
              record.invocation_id !== identity.invocation_id,
          )
        )
          return failed(
            "policy_denied",
            "Jev 当前 attempt 的绑定已改变；须显式创建新 attempt，不能通过改变绑定自动重发。",
          );
        const latest = latestModelInvocation(records, identity.invocation_id);
        if (
          latest !== undefined &&
          (!bindingMatches(latest, expected) ||
            latest.run_id !== identity.run_id ||
            latest.conversation_id !== identity.conversation_id)
        )
          return failed("policy_denied", "Jev 调用身份或绑定冲突；保留原记录，请显式恢复。");
        if (
          latest?.state === "started" ||
          (latest?.state === "completed" && latest.result_locator === undefined)
        )
          return failed(
            "uncertain",
            "Jev 上次调用外部结果不明；不会自动重发，请核查后显式创建新 attempt。",
          );
        if (latest?.state === "invalidated")
          return failed(
            "policy_denied",
            "Jev 调用身份已失效；请通过显式恢复创建新 attempt，不复用旧身份。",
          );
        if (latest?.state === "failed")
          return latest.failure === undefined
            ? failed("invalid_output", "Jev 失败记录缺少原始失败信息；不会自动重发。")
            : { status: "failed", failure: latest.failure };
        if (latest !== undefined && ["completed", "validated", "consumed"].includes(latest.state)) {
          validateOutput(readValidatedModelResult(deps.projectRoot, latest).value);
        } else {
          // Match the runner's chosen cache entry, but reject obsolete history and
          // validate the original response before the runner writes any replay states.
          const cached = records.find(
            (record) =>
              record.cache_key === expected.cache_key &&
              record.invocation_id !== identity.invocation_id &&
              record.result_locator !== undefined &&
              (record.state === "validated" || record.state === "consumed"),
          );
          if (cached !== undefined) {
            const current = latestModelInvocation(records, cached.invocation_id)!;
            if (
              !["validated", "consumed"].includes(current.state) ||
              !bindingMatches(current, expected) ||
              !bindingMatches(cached, expected) ||
              current.output_digest !== cached.output_digest ||
              current.result_locator !== cached.result_locator
            )
              return failed(
                "policy_denied",
                "Jev 历史缓存已失效或绑定不一致；不会复活旧结果或自动重发。",
              );
            validateOutput(readValidatedModelResult(deps.projectRoot, cached).value);
          }
        }
        const managedDeps = {
          ...deps,
          provider: deps.provider_factory.bind({
            request: prepared.request,
            binding: prepared.binding,
            compiled: compiled.compiled,
          }),
        };
        const outcome = await invokeManagedPrompt(managedDeps, {
          port_id: "impact_advisory",
          output_schema_id: contract.output_schema_id,
          ...identity,
          contract,
          compiled: compiled.compiled,
        });
        if (outcome.status === "failed") return { status: "failed", failure: outcome.failure };
        const output = validateOutput(outcome.value);
        consumeManagedInvocation(managedDeps, outcome.record);
        return {
          status: "proposed",
          additions: output.additions,
          edge_candidates: output.edge_candidates,
          risk_signals: output.risk_signals,
          missing_facts: output.missing_facts,
          questions: output.questions,
          local_diagnostic: prepared.local_diagnostic,
        };
      } catch (error) {
        if (error instanceof JevImpactMappingError)
          return {
            status: "failed",
            failure: { code: "invalid_output", summary: error.message, retryable: false },
          };
        if (error instanceof ModelResultArtifactError || error instanceof ModelInvocationStoreError)
          return failed(
            "invalid_output",
            "Jev 持久化调用或原始结果缺失、损坏或不匹配；保留证据，不自动重发。",
          );
        if (error instanceof ManagedRunnerError)
          return failed("policy_denied", "Jev 受管调用身份或绑定不匹配；不会自动恢复旧调用。");
        throw error;
      }
    },
  };
}
