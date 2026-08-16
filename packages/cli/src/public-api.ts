/**
 * Public API of the published `universal-harness` package (plan Task 28).
 *
 * Everything importable through the package root is re-exported here so the
 * published surface is one explicit, reviewable list: the in-process CLI
 * entry point, the orchestrated runtime service factory with its injectable
 * ports, and the typed error/exit-code contracts. Internal workspace packages
 * (`@universal-harness-internal/*`) stay private implementation details and
 * are never re-exported.
 */
export * from "./errors.js";
export * from "./io.js";
export * from "./project-runtime-config.js";
export * from "./project-gates.js";
export * from "./project-agent.js";
export {
  createOrchestratedRuntimeService,
  createEvalPackagePort,
  createReadlinePrompter,
  type OrchestratedServiceOptions,
} from "./runtime-service.js";
export {
  CLI_VERSION,
  createStubRuntimeService,
  runCli,
  type AdoptProjectRequest,
  type ApproveRequest,
  type CliDependencies,
  type CommandContext,
  type ImpactRequest,
  type FindingGroupRequest,
  type IterateRequest,
  type NewProjectRequest,
  type ProjectRequest,
  type ResumeRequest,
  type RunRequest,
  type RuntimeService,
} from "./router.js";
