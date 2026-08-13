import { PROVIDER_INSTRUCTION_TEMPLATE } from "@universal-harness-internal/plugin-sdk";

import { GENERIC_PACK } from "./pack.js";

/**
 * Neutral provider instruction template (plan Task 25 step 2). The template is
 * stack-agnostic canonical content; the Provider Instruction Projection binds
 * it to a Task Envelope and ContextBundle digest to produce a reproducible
 * provider mirror.
 */
export function genericProviderInstructionTemplate(): string {
  const template = GENERIC_PACK.templates[PROVIDER_INSTRUCTION_TEMPLATE];
  if (template === undefined) {
    throw new Error("generic pack is missing its provider instruction template");
  }
  return template;
}
