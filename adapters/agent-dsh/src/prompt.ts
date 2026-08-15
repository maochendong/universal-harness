import type { AgentTaskEnvelope } from "@universal-harness-internal/plugin-sdk";

function bulletList(values: readonly string[], empty: string): string[] {
  return values.length === 0 ? [`- ${empty}`] : [...values].sort().map((value) => `- ${value}`);
}

/** Render the complete governed envelope as one deterministic dsh headless task. */
export function renderDshTask(envelope: AgentTaskEnvelope): string {
  return [
    "You are executing one task governed by Universal Harness.",
    `Task: ${envelope.task_id}`,
    `Objective: ${envelope.objective}`,
    `Expected output: ${envelope.expected_output}`,
    "Acceptance criteria:",
    ...bulletList(envelope.acceptance_criteria, "none declared"),
    "Allowed read paths:",
    ...bulletList(envelope.allowed_read_paths, "none declared"),
    "Allowed write paths:",
    ...bulletList(envelope.proposed_write_paths, "none declared"),
    "Required gates:",
    ...bulletList(envelope.required_gate_ids, "none declared"),
    "Constraints:",
    "- Work only inside the current repository.",
    "- Do not modify .git or .harness authority/ledger files.",
    "- Do not claim completion until the requested implementation and tests are present.",
    "- Return a concise final summary; Universal Harness will independently verify it.",
  ].join("\n");
}
