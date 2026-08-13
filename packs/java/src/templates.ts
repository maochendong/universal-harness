import { PROVIDER_INSTRUCTION_TEMPLATE } from "@universal-harness-internal/plugin-sdk";

import { JAVA_PACK } from "./pack.js";

/**
 * Java provider instruction template (plan Task 25 step 2). Canonical pack
 * content; the Provider Instruction Projection binds it to a Task Envelope
 * and ContextBundle digest to produce a reproducible provider mirror.
 */
export function javaProviderInstructionTemplate(): string {
  const template = JAVA_PACK.templates[PROVIDER_INSTRUCTION_TEMPLATE];
  if (template === undefined) {
    throw new Error("java pack is missing its provider instruction template");
  }
  return template;
}
