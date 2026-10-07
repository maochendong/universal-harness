import {
  IMPACT_ADVISORY_SCHEMA_VERSION,
  JEV_IMPACT_SCHEMA_VERSION,
} from "@universal-harness-internal/core";
import {
  IMPACT_ADVISORY_PROMPT_CONTRACT,
  IMPACT_ADVISORY_PROMPT_VERSION,
  JEV_IMPACT_PROMPT_CONTRACT,
  JEV_IMPACT_PROMPT_VERSION,
} from "@universal-harness-internal/graph";

/** One contract selection shared by CapabilityPlan compilation and runtime assembly. */
export function impactProviderContract(kind: "managed_prompt" | "jev_impact"): {
  readonly prompt_version: string;
  readonly output_schema_id: string;
  readonly schema_version: string;
} {
  return kind === "jev_impact"
    ? {
        prompt_version: JEV_IMPACT_PROMPT_VERSION,
        output_schema_id: JEV_IMPACT_PROMPT_CONTRACT.output_schema_id,
        schema_version: JEV_IMPACT_SCHEMA_VERSION,
      }
    : {
        prompt_version: IMPACT_ADVISORY_PROMPT_VERSION,
        output_schema_id: IMPACT_ADVISORY_PROMPT_CONTRACT.output_schema_id,
        schema_version: IMPACT_ADVISORY_SCHEMA_VERSION,
      };
}
