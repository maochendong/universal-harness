import {
  abortIteration,
  resumeIteration,
  type AbortIterationInput,
  type OrchestratorDependencies,
  type RunIterationInput,
} from "@universal-harness-internal/runtime";

export interface CliResumeService {
  resume(input: {
    readonly projectRoot: string;
    readonly workflowOperationId: string;
    readonly answers?: RunIterationInput["answers"];
  }): ReturnType<typeof resumeIteration>;
  abort(input: {
    readonly projectRoot: string;
    readonly workflowOperationId: string;
    readonly actor: string;
  }): ReturnType<typeof abortIteration>;
}

/** Resume/abort command module; it translates inputs but owns no state. */
export function createCliResumeService(input: {
  readonly dependencies: (projectRoot: string) => OrchestratorDependencies;
}): CliResumeService {
  return {
    resume(request) {
      return resumeIteration(input.dependencies(request.projectRoot), request.workflowOperationId, {
        intent: "",
        intentShape: "pack-converted",
        ...(request.answers === undefined ? {} : { answers: request.answers }),
      });
    },
    abort(request) {
      const abortInput: AbortIterationInput = {
        workflowOperationId: request.workflowOperationId,
        actor: request.actor,
      };
      return abortIteration(input.dependencies(request.projectRoot), abortInput);
    },
  };
}
