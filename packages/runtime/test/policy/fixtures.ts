import { contentDigest } from "@universal-harness-internal/core";

import type { AdapterControlProfile, PolicyAction } from "../../src/policy/action.js";
import type { GrantRequest } from "../../src/policy/capability-grant.js";
import type {
  PolicyFieldInput,
  PolicyLayer,
  PolicyLayerInput,
  PolicyMergeOperator,
} from "../../src/policy/decision.js";

/** Shared builders for deterministic policy tests. */
export function field(
  path: string,
  mergeOperator: PolicyMergeOperator,
  value: unknown,
): PolicyFieldInput {
  return { path, merge_operator: mergeOperator, value };
}

export function layer(
  name: PolicyLayer,
  fields: readonly PolicyFieldInput[],
  revision = 1,
): PolicyLayerInput {
  return {
    layer: name,
    revision,
    digest: contentDigest({ layer: name, revision, fields }),
    fields,
  };
}

export const MANAGED_PROFILE: AdapterControlProfile = {
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
};

export const DELEGATED_PROFILE: AdapterControlProfile = {
  control: "delegated",
  trajectory_visibility: "summarized",
  usage_metering: true,
  side_effect_interception: false,
};

function mergeOverrides<T extends object>(
  defaults: Record<string, unknown>,
  overrides?: Partial<T>,
): T {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged as unknown as T;
}

export function action(overrides?: Partial<PolicyAction>): PolicyAction {
  return mergeOverrides<PolicyAction>(
    {
      kind: "read_path",
      actor: "adapter_01",
      actor_kind: "adapter",
      origin: "prompt",
      phase: "implementation",
      resource: "src/index.ts",
      parameters: {},
      risk: "low",
    },
    overrides,
  );
}

export function grantRequest(overrides?: Partial<GrantRequest>): GrantRequest {
  return mergeOverrides<GrantRequest>(
    {
      grant_id: "grant_01",
      task_id: "task_01",
      capabilities: ["edit-source"],
      read_paths: ["src"],
      write_paths: ["src"],
      state_fields: ["hypotheses"],
      tools: [{ name: "apply_patch" }],
      phase: "implementation",
      budget: { steps: 20, tokens: 50000 },
    },
    overrides,
  );
}
