import type {
  AgentProviderManifest,
  AgentRunOutput,
  AgentRunResult,
  AgentTaskEnvelope,
} from "@universal-harness-internal/plugin-sdk";

export interface OrchestrationExecutorOptions {
  readonly onOutput?: (output: AgentRunOutput) => void;
}

export type OrchestrationExecutor = (
  envelope: AgentTaskEnvelope,
  options?: OrchestrationExecutorOptions,
) => Promise<AgentRunResult>;

export interface ExecutionBinding {
  readonly kind: "workflow" | "agent";
  readonly name: string;
  readonly deterministic: boolean;
  readonly adapter_profile?: AgentProviderManifest;
  readonly execute: OrchestrationExecutor;
}

export type ExecutionBindingErrorKind = "migration_required" | "binding_mismatch";

export class ExecutionBindingError extends Error {
  readonly kind: ExecutionBindingErrorKind;

  constructor(kind: ExecutionBindingErrorKind, message: string) {
    super(message);
    this.name = "ExecutionBindingError";
    this.kind = kind;
  }
}

export function assertExecutionBindingCompatible(
  plan: { readonly execution_kind?: "workflow" | "agent"; readonly mode: string },
  binding: ExecutionBinding,
): void {
  if (plan.execution_kind === undefined) {
    throw new ExecutionBindingError(
      "migration_required",
      "execution plan predates execution-kind governance and must be replanned",
    );
  }
  if (plan.execution_kind !== binding.kind) {
    throw new ExecutionBindingError(
      "binding_mismatch",
      `plan requires ${plan.execution_kind} execution but ${binding.name} is ${binding.kind}`,
    );
  }
  if (plan.mode === "direct" && binding.kind !== "workflow") {
    throw new ExecutionBindingError(
      "binding_mismatch",
      "direct execution is restricted to deterministic workflow bindings",
    );
  }
}
